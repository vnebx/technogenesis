import asyncio
import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from functools import wraps

import aiohttp_jinja2
import jinja2
from aiohttp import web
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PLAYERDATA_DIR = os.path.join(BASE_DIR, "playerdata")
PLAYERLOGIN_PATH = os.path.join(BASE_DIR, "playerlogin.json")
WORLD_STATE_PATH = os.path.join(BASE_DIR, "world.json")
GAME_DIR = os.path.join(BASE_DIR, "game")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
WORLD_SEED_LENGTH = 24
MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT = 1
SESSION_COOKIE = "session"
SESSION_MAX_AGE = 30 * 24 * 3600
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

CONNECTED_CLIENTS = set()
PLAYER_CONNECTIONS = {}
SERVER_STATE = {"seed": None}
LIVE_PLAYER_STATE = {}
removed_trees = set()
ground_items = []
WS_SEND_LOCKS = {}

session_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="session")
ws_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="ws-auth")

app = web.Application()
aiohttp_jinja2.setup(app, loader=jinja2.FileSystemLoader(TEMPLATES_DIR))


def load_playerlogin():
    if not os.path.exists(PLAYERLOGIN_PATH):
        return {"users": {}}
    with open(PLAYERLOGIN_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_playerlogin(data):
    os.makedirs(os.path.dirname(PLAYERLOGIN_PATH), exist_ok=True)
    with open(PLAYERLOGIN_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def player_file_path(player_id):
    return os.path.join(PLAYERDATA_DIR, f"{player_id}.json")


def load_player(player_id):
    path = player_file_path(player_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_player(player_id, data):
    os.makedirs(PLAYERDATA_DIR, exist_ok=True)
    with open(player_file_path(player_id), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_client_ip(request):
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote or "unknown"


def load_session(request):
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return {}
    try:
        data = session_serializer.loads(raw, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def save_session(response, data):
    response.set_cookie(
        SESSION_COOKIE,
        session_serializer.dumps(data),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="Lax",
        path="/",
    )


def clear_session(response):
    response.del_cookie(SESSION_COOKIE, path="/")


def login_required(handler):
    @wraps(handler)
    async def wrapped(request):
        if not load_session(request).get("player_id"):
            return web.HTTPFound("/login")
        return await handler(request)

    return wrapped


def generate_ws_token(player_id):
    return ws_serializer.dumps({"player_id": player_id})


def verify_ws_token(token):
    try:
        payload = ws_serializer.loads(token, max_age=86400)
        return payload.get("player_id")
    except (BadSignature, SignatureExpired):
        return None


def validate_username(username):
    if not username or len(username) < 3 or len(username) > 32:
        return False
    return username.isalnum()


def validate_password(password):
    return password and len(password) >= 8


def generate_world_seed():
    return [secrets.randbelow(256) for _ in range(WORLD_SEED_LENGTH)]


def load_world_state():
    if not os.path.exists(WORLD_STATE_PATH):
        return {}
    with open(WORLD_STATE_PATH, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}


def normalize_ground_items(items):
    if not isinstance(items, list):
        return []
    result = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        item = entry.get("item")
        if not isinstance(item, str):
            continue
        try:
            count = int(entry.get("count", 1))
            x = float(entry.get("x", 0))
            y = float(entry.get("y", 0))
        except (TypeError, ValueError):
            continue
        result.append(
            {
                "id": str(entry.get("id")),
                "item": item,
                "count": max(1, count),
                "x": x,
                "y": y,
            }
        )
    return result


def save_world_state():
    with open(WORLD_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "seed": SERVER_STATE["seed"],
                "removed_trees": sorted(removed_trees),
                "ground_items": ground_items,
            },
            f,
            indent=2,
        )


def get_world_seed():
    if SERVER_STATE["seed"] is None:
        state = load_world_state()
        removed_trees.update(state.get("removed_trees", []))
        ground_items.extend(normalize_ground_items(state.get("ground_items")))
        if state.get("seed"):
            SERVER_STATE["seed"] = state["seed"]
        else:
            SERVER_STATE["seed"] = generate_world_seed()
            save_world_state()
    return SERVER_STATE["seed"]


def normalize_position(position):
    if not isinstance(position, dict):
        return {"x": 0, "y": 0}
    return {"x": float(position.get("x", 0)), "y": float(position.get("y", 0))}


def build_player_state(player_id, player):
    data = player.get("data", {}) or {}
    if not isinstance(data, dict):
        data = {}
    return {
        "player_id": player_id,
        "username": player.get("username", ""),
        "position": normalize_position(data.get("position", {"x": 0, "y": 0})),
        "animation": data.get("animation", "idle"),
        "character": data.get("character", "assets/characters/basicrobot"),
        "inventory": data.get("inventory", []),
    }


def active_player_connections(player_id):
    return PLAYER_CONNECTIONS.get(player_id, set())


def register_player_connection(player_id, websocket):
    connections = PLAYER_CONNECTIONS.setdefault(player_id, set())
    if len(connections) >= MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT:
        return False
    connections.add(websocket)
    return True


def unregister_player_connection(player_id, websocket):
    connections = PLAYER_CONNECTIONS.get(player_id)
    if not connections:
        return
    connections.discard(websocket)
    if not connections:
        PLAYER_CONNECTIONS.pop(player_id, None)


def collect_active_players_snapshot():
    players = {}
    for player_id in PLAYER_CONNECTIONS:
        live = LIVE_PLAYER_STATE.get(player_id)
        if live is not None:
            players[player_id] = live
            continue
        player = load_player(player_id)
        if player is not None:
            players[player_id] = build_player_state(player_id, player)
    return players


async def safe_send(websocket, message):
    lock = WS_SEND_LOCKS.setdefault(id(websocket), asyncio.Lock())
    async with lock:
        await websocket.send_str(message)


async def broadcast_world_state():
    payload = {
        "type": "state",
        "seed": get_world_seed(),
        "removed_trees": sorted(removed_trees),
        "ground_items": ground_items,
        "players": collect_active_players_snapshot(),
    }
    message = json.dumps(payload)
    for websocket in list(CONNECTED_CLIENTS):
        try:
            await safe_send(websocket, message)
        except Exception:
            CONNECTED_CLIENTS.discard(websocket)


async def index(request):
    if load_session(request).get("player_id"):
        return web.HTTPFound("/game/")
    return web.HTTPFound("/login")


async def login(request):
    if load_session(request).get("player_id"):
        return web.HTTPFound("/game/")

    if request.method == "GET":
        return aiohttp_jinja2.render_template("login.html", request, {"error": None})

    form = await request.post()
    username = (form.get("username") or "").strip().lower()
    password = form.get("password") or ""

    data = load_playerlogin()
    user = data["users"].get(username)
    if user is None or not check_password_hash(user["password_hash"], password):
        return aiohttp_jinja2.render_template(
            "login.html", request, {"error": "Invalid username or password."}
        )

    if len(active_player_connections(user["player_id"])) >= MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT:
        return aiohttp_jinja2.render_template(
            "login.html", request, {"error": "This account is already logged in from another session."}
        )

    user["last_ip"] = get_client_ip(request)
    save_playerlogin(data)

    response = web.HTTPFound("/game/")
    save_session(
        response,
        {
            "player_id": user["player_id"],
            "username": username,
            "ws_token": generate_ws_token(user["player_id"]),
        },
    )
    return response


async def register(request):
    if load_session(request).get("player_id"):
        return web.HTTPFound("/game/")

    if request.method == "GET":
        return aiohttp_jinja2.render_template("register.html", request, {"error": None})

    form = await request.post()
    username = (form.get("username") or "").strip().lower()
    password = form.get("password") or ""

    if not validate_username(username):
        return aiohttp_jinja2.render_template(
            "register.html",
            request,
            {"error": "Username must be 3-32 alphanumeric characters."},
        )
    if not validate_password(password):
        return aiohttp_jinja2.render_template(
            "register.html",
            request,
            {"error": "Password must be at least 8 characters."},
        )

    data = load_playerlogin()
    if username in data["users"]:
        return aiohttp_jinja2.render_template("register.html", request, {"error": "Username already taken."})

    player_id = str(uuid.uuid4())
    data["users"][username] = {
        "password_hash": generate_password_hash(password),
        "player_id": player_id,
        "last_ip": None,
    }
    save_playerlogin(data)

    save_player(
        player_id,
        {
            "player_id": player_id,
            "username": username,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "data": {
                "position": {"x": 0, "y": 0},
                "animation": "idle",
                "character": "assets/characters/basicrobot",
                "inventory": [],
            },
        },
    )

    response = web.HTTPFound("/game/")
    save_session(
        response,
        {
            "player_id": player_id,
            "username": username,
            "ws_token": generate_ws_token(player_id),
        },
    )
    return response


@login_required
async def ws_token(request):
    session = load_session(request)
    return web.json_response({"token": session["ws_token"]})


@login_required
async def player_data(request):
    session = load_session(request)
    player = load_player(session["player_id"])
    if player is None:
        return web.json_response({"data": {}})
    return web.json_response({"data": player.get("data", {})})


@login_required
async def game(request):
    session = load_session(request)
    player = load_player(session["player_id"])
    if player is None:
        response = web.HTTPFound("/login")
        clear_session(response)
        return response

    filename = request.match_info.get("tail") or "index.html"
    path = os.path.normpath(os.path.join(GAME_DIR, filename))
    if path != GAME_DIR and not path.startswith(GAME_DIR + os.sep):
        return web.HTTPForbidden()
    if os.path.isdir(path):
        path = os.path.join(path, "index.html")
    if not os.path.isfile(path):
        return web.HTTPNotFound()
    response = web.FileResponse(path)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


async def websocket_handler(request):
    websocket = web.WebSocketResponse(max_msg_size=8 * 1024 * 1024)
    await websocket.prepare(request)

    try:
        raw = await asyncio.wait_for(websocket.receive(), timeout=10)
    except asyncio.TimeoutError:
        await websocket.close(code=4001, message=b"Auth required")
        return websocket

    if raw.type != web.WSMsgType.TEXT:
        await websocket.close(code=4001, message=b"Auth required")
        return websocket

    try:
        auth_msg = json.loads(raw.data)
        token = auth_msg.get("token")
    except (json.JSONDecodeError, AttributeError):
        await websocket.close(code=4001, message=b"Auth required")
        return websocket

    player_id = verify_ws_token(token)
    if player_id is None or load_player(player_id) is None:
        await websocket.close(code=4003, message=b"Unauthorized")
        return websocket

    if not register_player_connection(player_id, websocket):
        await websocket.close(code=4004, message=b"Max active sessions reached")
        return websocket

    CONNECTED_CLIENTS.add(websocket)
    connected_player = load_player(player_id)
    if connected_player is not None:
        LIVE_PLAYER_STATE[player_id] = build_player_state(player_id, connected_player)
    try:
        welcome = {
            "type": "welcome",
            "seed": get_world_seed(),
            "removed_trees": sorted(removed_trees),
            "ground_items": ground_items,
            "player_id": player_id,
            "players": collect_active_players_snapshot(),
        }
        await safe_send(websocket, json.dumps(welcome))

        async for raw in websocket:
            if raw.type != web.WSMsgType.TEXT:
                break
            try:
                msg = json.loads(raw.data)
            except json.JSONDecodeError:
                await safe_send(websocket, json.dumps({"error": "invalid_json"}))
                continue

            operation = msg.get("operation")
            if operation in {"save", "update"}:
                player = load_player(player_id)
                if player is None:
                    continue

                payload = msg.get("data", {}) or {}
                if not isinstance(payload, dict):
                    payload = {}

                data = player.get("data", {}) or {}
                if not isinstance(data, dict):
                    data = {}

                position = normalize_position(payload.get("position", data.get("position", {"x": 0, "y": 0})))
                animation = payload.get("animation", data.get("animation", "idle"))
                character = payload.get("character", data.get("character", "assets/characters/basicrobot"))
                inventory = payload.get("inventory") if "inventory" in payload else data.get("inventory", [])

                player["data"] = {
                    "position": position,
                    "animation": animation,
                    "character": character,
                    "inventory": inventory,
                }
                save_player(player_id, player)
                LIVE_PLAYER_STATE[player_id] = build_player_state(player_id, player)
                await broadcast_world_state()
                await safe_send(websocket, json.dumps({"ok": True, "type": "sync"}))
            elif operation == "remove_tree":
                tree_key = msg.get("tree")
                if not isinstance(tree_key, str) or "," not in tree_key:
                    await safe_send(websocket, json.dumps({"error": "invalid_tree"}))
                    continue
                try:
                    col, row = tree_key.split(",", 1)
                    int(col)
                    int(row)
                except ValueError:
                    await safe_send(websocket, json.dumps({"error": "invalid_tree"}))
                    continue

                if tree_key not in removed_trees:
                    removed_trees.add(tree_key)
                    save_world_state()
                    await broadcast_world_state()
                await safe_send(websocket, json.dumps({"ok": True, "type": "sync"}))
            elif operation == "drop_item":
                data = msg.get("data", {}) or {}
                if not isinstance(data, dict):
                    data = {}
                item = data.get("item")
                try:
                    count = int(data.get("count", 1))
                    x = float(data.get("x", 0))
                    y = float(data.get("y", 0))
                except (TypeError, ValueError):
                    await safe_send(websocket, json.dumps({"error": "invalid_item"}))
                    continue
                if not isinstance(item, str) or not item or count < 1 or count > 64:
                    await safe_send(websocket, json.dumps({"error": "invalid_item"}))
                    continue
                ground_items.append(
                    {
                        "id": str(uuid.uuid4()),
                        "item": item,
                        "count": count,
                        "x": x,
                        "y": y,
                    }
                )
                save_world_state()
                await broadcast_world_state()
                await safe_send(websocket, json.dumps({"ok": True, "type": "sync"}))
            elif operation == "pickup_item":
                item_id = msg.get("id")
                if not isinstance(item_id, str):
                    await safe_send(websocket, json.dumps({"error": "invalid_item"}))
                    continue
                removed = [g for g in ground_items if g["id"] == item_id]
                if removed:
                    ground_items.remove(removed[0])
                    save_world_state()
                    await broadcast_world_state()
                await safe_send(websocket, json.dumps({"ok": True, "type": "sync"}))
            elif operation == "get":
                player = load_player(player_id)
                await safe_send(
                    websocket,
                    json.dumps(
                        {
                            "data": player.get("data", {}) if player else {},
                            "seed": get_world_seed(),
                            "removed_trees": sorted(removed_trees),
                            "ground_items": ground_items,
                            "players": collect_active_players_snapshot(),
                        }
                    ),
                )
            else:
                await safe_send(websocket, json.dumps({"error": "unknown_operation"}))
    finally:
        CONNECTED_CLIENTS.discard(websocket)
        unregister_player_connection(player_id, websocket)
        WS_SEND_LOCKS.pop(id(websocket), None)
        if not active_player_connections(player_id):
            LIVE_PLAYER_STATE.pop(player_id, None)
    return websocket


app.router.add_get("/", index)
app.router.add_get("/login", login)
app.router.add_post("/login", login)
app.router.add_get("/register", register)
app.router.add_post("/register", register)
app.router.add_get("/api/ws-token", ws_token)
app.router.add_get("/api/player-data", player_data)
app.router.add_get("/game", game)
app.router.add_get("/game/{tail:.*}", game)
app.router.add_get("/ws", websocket_handler)


def main():
    os.makedirs(PLAYERDATA_DIR, exist_ok=True)
    os.makedirs(GAME_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", "8080"))
    print(f"Technogenesis server listening on port {port}")
    web.run_app(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
