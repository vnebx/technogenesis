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
SERVERS_PATH = os.path.join(BASE_DIR, "servers.json")
WORLDS_DIR = os.path.join(BASE_DIR, "worlds")
GAME_DIR = os.path.join(BASE_DIR, "game")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
WORLD_SEED_LENGTH = 24
MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT = 1
MAX_SERVERS_PER_ACCOUNT = 20
DEFAULT_CHARACTER = "assets/characters/basicrobot"
SESSION_COOKIE = "session"
SESSION_MAX_AGE = 30 * 24 * 3600
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
SERVER_ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"
SERVER_ID_LENGTH = 6

SERVER_INSTANCES = {}
SERVERS_CACHE = None
CONNECTED_CLIENTS = {}
PLAYER_CONNECTIONS = {}
LIVE_PLAYER_STATE = {}
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


def generate_ws_token(player_id, server_id):
    return ws_serializer.dumps({"player_id": player_id, "server_id": server_id})


def verify_ws_token(token):
    try:
        payload = ws_serializer.loads(token, max_age=86400)
        if not isinstance(payload, dict):
            return None
        return payload
    except (BadSignature, SignatureExpired):
        return None


def validate_username(username):
    if not username or len(username) < 3 or len(username) > 32:
        return False
    return username.islower() and username.isalnum()


def validate_password(password):
    return password and len(password) >= 8


def generate_world_seed():
    return [secrets.randbelow(256) for _ in range(WORLD_SEED_LENGTH)]


# --- Server registry -----------------------------------------------------


def load_servers():
    global SERVERS_CACHE
    if SERVERS_CACHE is not None:
        return SERVERS_CACHE
    if not os.path.exists(SERVERS_PATH):
        SERVERS_CACHE = []
        return SERVERS_CACHE
    with open(SERVERS_PATH, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = {}
    servers = data.get("servers")
    SERVERS_CACHE = servers if isinstance(servers, list) else []
    return SERVERS_CACHE


def save_servers(servers):
    global SERVERS_CACHE
    SERVERS_CACHE = servers
    os.makedirs(BASE_DIR, exist_ok=True)
    with open(SERVERS_PATH, "w", encoding="utf-8") as f:
        json.dump({"servers": servers}, f, indent=2)


def normalize_server_id(value):
    return (value or "").strip().lower()


def get_server(server_id):
    server_id = normalize_server_id(server_id)
    for server in load_servers():
        if server.get("id") == server_id:
            return server
    return None


def generate_server_id():
    while True:
        candidate = "".join(secrets.choice(SERVER_ID_CHARS) for _ in range(SERVER_ID_LENGTH))
        if get_server(candidate) is None:
            return candidate


def create_server(name, owner_id, visibility, password, singleplayer=False):
    servers = load_servers()
    server = {
        "id": generate_server_id(),
        "name": name,
        "owner": owner_id,
        "singleplayer": bool(singleplayer),
        "visibility": visibility,
        "password_hash": generate_password_hash(password) if password else None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    servers.append(server)
    save_servers(servers)
    return server


def delete_server(server_id, owner_id):
    server_id = normalize_server_id(server_id)
    servers = load_servers()
    remaining = []
    removed = None
    for server in servers:
        if server.get("id") == server_id:
            removed = server
        else:
            remaining.append(server)
    if removed is None or removed.get("owner") != owner_id:
        return False
    save_servers(remaining)
    SERVER_INSTANCES.pop(server_id, None)
    path = os.path.join(WORLDS_DIR, f"{server_id}.json")
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass
    return True


def public_server_info(server, session):
    player_id = session.get("player_id")
    return {
        "id": server["id"],
        "name": server.get("name", ""),
        "visibility": server.get("visibility", "public"),
        "singleplayer": bool(server.get("singleplayer")),
        "is_owner": bool(server.get("owner") and server.get("owner") == player_id),
    }


def server_access_dict(session):
    access = session.get("server_access")
    return access if isinstance(access, dict) else {}


def server_access_ok(session, server):
    server_id = server["id"]
    if server.get("singleplayer"):
        return session.get("player_id") == server.get("owner")
    if server.get("visibility") == "private":
        if server.get("owner") and server.get("owner") == session.get("player_id"):
            return True
        if server_access_dict(session).get(server_id):
            return True
        return False
    return True


# --- Per-server world state ----------------------------------------------


def world_state_path(server_id):
    return os.path.join(WORLDS_DIR, f"{server_id}.json")


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


def save_world_state(server_id):
    instance = SERVER_INSTANCES.get(server_id)
    if instance is None:
        return
    os.makedirs(WORLDS_DIR, exist_ok=True)
    with open(world_state_path(server_id), "w", encoding="utf-8") as f:
        json.dump(
            {
                "seed": instance["seed"],
                "removed_trees": sorted(instance["removed_trees"]),
                "ground_items": instance["ground_items"],
            },
            f,
            indent=2,
        )


def get_server_instance(server_id):
    instance = SERVER_INSTANCES.get(server_id)
    if instance is not None:
        return instance

    instance = {"seed": None, "removed_trees": set(), "ground_items": []}
    state = None
    if os.path.exists(world_state_path(server_id)):
        with open(world_state_path(server_id), "r", encoding="utf-8") as f:
            try:
                state = json.load(f)
            except (json.JSONDecodeError, OSError):
                state = None
    if isinstance(state, dict):
        if state.get("seed"):
            instance["seed"] = state["seed"]
        instance["removed_trees"].update(str(k) for k in state.get("removed_trees", []))
        instance["ground_items"] = normalize_ground_items(state.get("ground_items"))

    SERVER_INSTANCES[server_id] = instance
    if not instance["seed"]:
        instance["seed"] = generate_world_seed()
        save_world_state(server_id)
    return instance


# --- Per-server player state ---------------------------------------------


def default_player_profile():
    return {
        "position": {"x": 0, "y": 0},
        "animation": "idle",
        "character": DEFAULT_CHARACTER,
        "inventory": [],
    }


def get_player_data(player, server_id):
    data = player.get("data")
    if not isinstance(data, dict):
        return default_player_profile()
    if any(key in data for key in ("position", "inventory", "animation", "character")):
        return data
    profile = data.get(server_id)
    if not isinstance(profile, dict):
        return default_player_profile()
    return profile


def set_player_data(player, server_id, profile):
    data = player.get("data")
    if not isinstance(data, dict) or any(key in data for key in ("position", "inventory", "animation", "character")):
        data = {}
    data[server_id] = profile
    player["data"] = data


def normalize_position(position):
    if not isinstance(position, dict):
        return {"x": 0, "y": 0}
    return {"x": float(position.get("x", 0)), "y": float(position.get("y", 0))}


def build_player_state(player_id, player, server_id):
    data = get_player_data(player, server_id)
    return {
        "player_id": player_id,
        "username": player.get("username", ""),
        "position": normalize_position(data.get("position", {"x": 0, "y": 0})),
        "animation": data.get("animation", "idle"),
        "character": data.get("character", DEFAULT_CHARACTER),
        "inventory": data.get("inventory", []),
    }


def active_player_connections(player_id):
    connections = set()
    for per_server in PLAYER_CONNECTIONS.values():
        connections |= per_server.get(player_id, set())
    return connections


def register_player_connection(server_id, player_id, websocket):
    if len(active_player_connections(player_id)) >= MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT:
        return False
    per_server = PLAYER_CONNECTIONS.setdefault(server_id, {})
    per_server.setdefault(player_id, set()).add(websocket)
    return True


def unregister_player_connection(server_id, player_id, websocket):
    per_server = PLAYER_CONNECTIONS.get(server_id)
    if not per_server:
        return
    connections = per_server.get(player_id)
    if not connections:
        return
    connections.discard(websocket)
    if not connections:
        per_server.pop(player_id, None)
    if not per_server:
        PLAYER_CONNECTIONS.pop(server_id, None)


def collect_active_players_snapshot(server_id):
    players = {}
    per_server = PLAYER_CONNECTIONS.get(server_id, {})
    for player_id in per_server:
        live = LIVE_PLAYER_STATE.get(server_id, {}).get(player_id)
        if live is not None:
            players[player_id] = live
            continue
        player = load_player(player_id)
        if player is not None:
            players[player_id] = build_player_state(player_id, player, server_id)
    return players


async def safe_send(websocket, message):
    lock = WS_SEND_LOCKS.setdefault(id(websocket), asyncio.Lock())
    async with lock:
        await websocket.send_str(message)


async def broadcast_world_state(server_id):
    instance = get_server_instance(server_id)
    payload = {
        "type": "state",
        "seed": instance["seed"],
        "removed_trees": sorted(instance["removed_trees"]),
        "ground_items": instance["ground_items"],
        "players": collect_active_players_snapshot(server_id),
    }
    message = json.dumps(payload)
    for websocket in list(CONNECTED_CLIENTS.get(server_id, set())):
        try:
            await safe_send(websocket, message)
        except Exception:
            CONNECTED_CLIENTS.setdefault(server_id, set()).discard(websocket)


# --- HTTP pages -----------------------------------------------------------


async def index(request):
    session = load_session(request)
    player = None
    if session.get("player_id"):
        player = load_player(session["player_id"])
    return aiohttp_jinja2.render_template(
        "menu.html",
        request,
        {
            "logged_in": bool(session.get("player_id")),
            "username": (session.get("username") or (player.get("username") if player else "")) or "",
        },
    )


async def logout(request):
    response = web.HTTPFound("/")
    clear_session(response)
    return response


def server_render_context(session, server_id, next_target):
    if not server_id:
        return {
            "error": None,
            "status": "none",
            "server": server_id,
            "next": next_target,
            "server_name": None,
        }
    server = get_server(server_id)
    if server is None:
        return {
            "error": None,
            "status": "missing",
            "server": server_id,
            "next": next_target,
            "server_name": None,
        }
    require_server_password = bool(
        server.get("visibility") == "private"
        and not (server.get("owner") and server.get("owner") == session.get("player_id"))
    )
    return {
        "error": None,
        "status": "ok",
        "server": server_id,
        "next": next_target,
        "server_name": server.get("name", ""),
        "server_private": server.get("visibility") == "private",
        "server_singleplayer": bool(server.get("singleplayer")),
        "require_server_password": require_server_password,
    }


async def login(request):
    session = load_session(request)
    server_id = normalize_server_id(request.query.get("server"))
    next_target = (request.query.get("next") or "").strip()

    server = get_server(server_id) if server_id else None

    if request.method == "GET":
        if session.get("player_id"):
            if server:
                if server_access_ok(session, server):
                    return web.HTTPFound(f"/game/?server={server_id}")
                return web.HTTPFound(f"/join/{server_id}")
            if not server_id and not next_target:
                return web.HTTPFound("/")
        return aiohttp_jinja2.render_template(
            "login.html", request, server_render_context(session, server_id, next_target)
        )

    form = await request.post()
    username = (form.get("username") or "").strip().lower()
    password = form.get("password") or ""
    server_password = form.get("server_password") or ""
    server_id = normalize_server_id(form.get("server"))
    next_target = (form.get("next") or next_target).strip()

    data = load_playerlogin()
    user = data["users"].get(username)
    if user is None or not check_password_hash(user["password_hash"], password):
        context = server_render_context({}, server_id, next_target)
        context["error"] = "Invalid username or password."
        return aiohttp_jinja2.render_template("login.html", request, context)

    if len(active_player_connections(user["player_id"])) >= MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT:
        context = server_render_context({}, server_id, next_target)
        context["error"] = "This account is already logged in from another session."
        return aiohttp_jinja2.render_template("login.html", request, context)

    user["last_ip"] = get_client_ip(request)
    save_playerlogin(data)

    new_session = {"player_id": user["player_id"], "username": username}
    error = None
    if server_id:
        server = get_server(server_id)
        if server is None:
            error = "That server does not exist."
        elif server.get("singleplayer") and server.get("owner") != user["player_id"]:
            error = "That singleplayer world belongs to another player."
        elif server.get("visibility") == "private" and server.get("owner") != user["player_id"]:
            if not server.get("password_hash") or not server_password or not check_password_hash(server["password_hash"], server_password):
                error = "Incorrect server password."
            else:
                new_session["server_access"] = {server_id: True}

    if error:
        context = server_render_context({}, server_id, next_target)
        context["error"] = error
        return aiohttp_jinja2.render_template("login.html", request, context)

    if next_target == "singleplayer":
        response = web.HTTPFound("/singleplayer")
    elif next_target == "multiplayer":
        response = web.HTTPFound("/multiplayer")
    elif server_id:
        response = web.HTTPFound(f"/game/?server={server_id}")
    else:
        response = web.HTTPFound("/")
    save_session(response, new_session)
    return response


async def register(request):
    session = load_session(request)
    server_id = normalize_server_id(request.query.get("server"))
    next_target = (request.query.get("next") or "").strip()

    server = get_server(server_id) if server_id else None

    if request.method == "GET":
        if session.get("player_id") and not server_id and not next_target:
            return web.HTTPFound("/")
        return aiohttp_jinja2.render_template(
            "register.html", request, server_render_context(session, server_id, next_target)
        )

    form = await request.post()
    username = (form.get("username") or "").strip().lower()
    password = form.get("password") or ""
    server_password = form.get("server_password") or ""
    server_id = normalize_server_id(form.get("server"))
    next_target = (form.get("next") or next_target).strip()

    context = server_render_context(session, server_id, next_target)

    if not validate_username(username):
        context["error"] = "Username must be 3-32 lowercase letters or numbers."
        return aiohttp_jinja2.render_template("register.html", request, context)
    if not validate_password(password):
        context["error"] = "Password must be at least 8 characters."
        return aiohttp_jinja2.render_template("register.html", request, context)

    data = load_playerlogin()
    if username in data["users"]:
        context["error"] = "Username already taken."
        return aiohttp_jinja2.render_template("register.html", request, context)

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
            "data": {},
        },
    )

    new_session = {"player_id": player_id, "username": username}
    if server_id:
        server = get_server(server_id)
        if server is None:
            context["error"] = "That server does not exist."
        elif server.get("singleplayer"):
            context["error"] = "That singleplayer world belongs to another player."
        elif server.get("visibility") == "private" and server.get("owner") != player_id:
            if not server.get("password_hash") or not server_password or not check_password_hash(server["password_hash"], server_password):
                context["error"] = "Incorrect server password."
            else:
                new_session["server_access"] = {server_id: True}

    if context["error"]:
        return aiohttp_jinja2.render_template("register.html", request, context)

    if next_target == "singleplayer":
        response = web.HTTPFound("/singleplayer")
    elif next_target == "multiplayer":
        response = web.HTTPFound("/multiplayer")
    elif server_id:
        response = web.HTTPFound(f"/game/?server={server_id}")
    else:
        response = web.HTTPFound("/")
    save_session(response, new_session)
    return response


async def singleplayer(request):
    session = load_session(request)
    if not session.get("player_id"):
        return web.HTTPFound("/login?next=singleplayer")
    player_id = session["player_id"]
    server = next(
        (s for s in load_servers() if s.get("singleplayer") and s.get("owner") == player_id),
        None,
    )
    if server is None:
        server = create_server("Singleplayer", player_id, "private", None, singleplayer=True)
    get_server_instance(server["id"])
    return web.HTTPFound(f"/game/?server={server['id']}")


async def multiplayer(request):
    session = load_session(request)
    if not session.get("player_id"):
        return web.HTTPFound("/login?next=multiplayer")
    return aiohttp_jinja2.render_template(
        "multiplayer.html", request, {"username": session.get("username", "")}
    )


async def join_server(request):
    session = load_session(request)
    server_id = normalize_server_id(request.match_info.get("server_id"))
    server = get_server(server_id)

    if not session.get("player_id"):
        return web.HTTPFound(f"/login?server={server_id}")
    if server is None:
        return web.HTTPFound("/multiplayer")

    if request.method == "GET":
        if server_access_ok(session, server):
            return web.HTTPFound(f"/game/?server={server_id}")
        error = None
        if server.get("singleplayer"):
            error = "This singleplayer world belongs to another player."
        return aiohttp_jinja2.render_template(
            "join.html",
            request,
            {
                "server_id": server_id,
                "server_name": server.get("name", ""),
                "singleplayer": bool(server.get("singleplayer")),
                "error": error,
            },
        )

    form = await request.post()
    server_password = form.get("password") or ""
    if server.get("singleplayer"):
        return aiohttp_jinja2.render_template(
            "join.html",
            request,
            {
                "server_id": server_id,
                "server_name": server.get("name", ""),
                "singleplayer": True,
                "error": "This singleplayer world belongs to another player.",
            },
        )
    if not server.get("password_hash") or not check_password_hash(server["password_hash"], server_password):
        return aiohttp_jinja2.render_template(
            "join.html",
            request,
            {
                "server_id": server_id,
                "server_name": server.get("name", ""),
                "singleplayer": False,
                "error": "Incorrect server password.",
            },
        )
    access = server_access_dict(session)
    access[server_id] = True
    session["server_access"] = access
    response = web.HTTPFound(f"/game/?server={server_id}")
    save_session(response, session)
    return response


async def game(request):
    session = load_session(request)
    server_id = normalize_server_id(request.query.get("server"))
    filename = request.match_info.get("tail") or "index.html"

    if not session.get("player_id"):
        if filename == "index.html":
            if server_id:
                return web.HTTPFound(f"/login?server={server_id}")
            return web.HTTPFound("/")
        return web.HTTPFound("/")

    if filename == "index.html":
        server = get_server(server_id) if server_id else None
        if server is None:
            return web.HTTPFound("/")
        if not server_access_ok(session, server):
            return web.HTTPFound(f"/join/{server_id}")

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


# --- API ---------------------------------------------------------------


async def whoami(request):
    session = load_session(request)
    player_id = session.get("player_id")
    if not player_id:
        return web.json_response({"logged_in": False})
    player = load_player(player_id)
    username = session.get("username") or (player.get("username") if player else "") or ""
    return web.json_response({"logged_in": True, "player_id": player_id, "username": username})


async def my_servers(request):
    session = load_session(request)
    player_id = session.get("player_id")
    if not player_id:
        return web.json_response({"error": "not_logged_in"}, status=401)
    servers = [public_server_info(s, session) for s in load_servers() if s.get("owner") == player_id]
    return web.json_response({"servers": servers})


async def public_servers(request):
    session = load_session(request)
    player_id = session.get("player_id")
    if not player_id:
        return web.json_response({"error": "not_logged_in"}, status=401)
    servers = [
        public_server_info(s, session)
        for s in load_servers()
        if not s.get("singleplayer")
        and s.get("visibility") == "public"
        and s.get("owner") != player_id
    ]
    return web.json_response({"servers": servers})


async def create_server_handler(request):
    session = load_session(request)
    player_id = session.get("player_id")
    if not player_id:
        return web.json_response({"error": "not_logged_in"}, status=401)
    try:
        body = await request.json()
    except (json.JSONDecodeError, TypeError):
        body = {}
    if not isinstance(body, dict):
        body = {}

    name = str(body.get("name") or "").strip()[:40]
    visibility = "private" if body.get("visibility") == "private" else "public"
    password = str(body.get("password") or "")

    if not name:
        return web.json_response({"error": "Server needs a name."}, status=400)
    if visibility == "private" and len(password) < 3:
        return web.json_response({"error": "Private servers need a password (at least 3 characters)."}, status=400)

    owned = [s for s in load_servers() if s.get("owner") == player_id]
    if len(owned) >= MAX_SERVERS_PER_ACCOUNT:
        return web.json_response({"error": "You reached the server limit."}, status=400)

    server = create_server(name, player_id, visibility, password)
    get_server_instance(server["id"])
    return web.json_response({"server": public_server_info(server, session)})


async def delete_server_handler(request):
    session = load_session(request)
    player_id = session.get("player_id")
    if not player_id:
        return web.json_response({"error": "not_logged_in"}, status=401)
    server_id = normalize_server_id(request.match_info.get("server_id"))
    if delete_server(server_id, player_id):
        return web.json_response({"ok": True})
    return web.json_response({"error": "Server not found or not yours."}, status=404)


async def server_info(request):
    session = load_session(request)
    server_id = normalize_server_id(request.match_info.get("server_id"))
    server = get_server(server_id)
    if server is None:
        return web.json_response({"error": "not_found"}, status=404)
    info = public_server_info(server, session)
    info["found"] = True
    return web.json_response(info)


async def ws_token(request):
    session = load_session(request)
    player_id = session.get("player_id")
    server_id = normalize_server_id(request.query.get("server"))
    if not player_id:
        return web.json_response({"error": "not_logged_in"}, status=401)
    server = get_server(server_id)
    if server is None:
        return web.json_response({"error": "server_not_found"}, status=404)
    if not server_access_ok(session, server):
        return web.json_response({"error": "access_denied"}, status=403)
    return web.json_response({"token": generate_ws_token(player_id, server_id)})


async def player_data(request):
    session = load_session(request)
    player_id = session.get("player_id")
    server_id = normalize_server_id(request.query.get("server"))
    if not player_id:
        return web.json_response({"error": "not_logged_in"}, status=401)
    server = get_server(server_id)
    if server is None or not server_access_ok(session, server):
        return web.json_response({"error": "access_denied"}, status=403)
    player = load_player(player_id)
    if player is None:
        return web.json_response({"data": {}})
    return web.json_response({"data": get_player_data(player, server_id)})


# --- WebSocket -----------------------------------------------------------


async def websocket_handler(request):
    websocket = web.WebSocketResponse(max_msg_size=8 * 1024 * 1024)
    await websocket.prepare(request)
    server_id = normalize_server_id(request.query.get("server"))

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

    auth = verify_ws_token(token)
    if auth is None:
        await websocket.close(code=4003, message=b"Unauthorized")
        return websocket

    player_id = auth.get("player_id")
    token_server = auth.get("server_id")
    if player_id is None or token_server != server_id:
        await websocket.close(code=4003, message=b"Unauthorized")
        return websocket

    server = get_server(server_id)
    player = load_player(player_id)
    if player is None or server is None:
        await websocket.close(code=4003, message=b"Unauthorized")
        return websocket
    if not server_access_ok(load_session(request), server):
        await websocket.close(code=4003, message=b"Unauthorized")
        return websocket

    if not register_player_connection(server_id, player_id, websocket):
        await websocket.close(code=4004, message=b"Max active sessions reached")
        return websocket

    CONNECTED_CLIENTS.setdefault(server_id, set()).add(websocket)
    LIVE_PLAYER_STATE.setdefault(server_id, {})[player_id] = build_player_state(player_id, player, server_id)
    instance = get_server_instance(server_id)

    try:
        welcome = {
            "type": "welcome",
            "seed": instance["seed"],
            "removed_trees": sorted(instance["removed_trees"]),
            "ground_items": instance["ground_items"],
            "player_id": player_id,
            "players": collect_active_players_snapshot(server_id),
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

                profile = get_player_data(player, server_id)
                position = normalize_position(payload.get("position", profile.get("position", {"x": 0, "y": 0})))
                animation = payload.get("animation", profile.get("animation", "idle"))
                character = payload.get("character", profile.get("character", DEFAULT_CHARACTER))
                inventory = payload.get("inventory") if "inventory" in payload else profile.get("inventory", [])

                new_profile = {
                    "position": position,
                    "animation": animation,
                    "character": character,
                    "inventory": inventory,
                }
                set_player_data(player, server_id, new_profile)
                save_player(player_id, player)
                LIVE_PLAYER_STATE.setdefault(server_id, {})[player_id] = build_player_state(player_id, player, server_id)
                await broadcast_world_state(server_id)
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

                if tree_key not in instance["removed_trees"]:
                    instance["removed_trees"].add(tree_key)
                    save_world_state(server_id)
                    await broadcast_world_state(server_id)
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
                instance["ground_items"].append(
                    {
                        "id": str(uuid.uuid4()),
                        "item": item,
                        "count": count,
                        "x": x,
                        "y": y,
                    }
                )
                save_world_state(server_id)
                await broadcast_world_state(server_id)
                await safe_send(websocket, json.dumps({"ok": True, "type": "sync"}))
            elif operation == "pickup_item":
                item_id = msg.get("id")
                if not isinstance(item_id, str):
                    await safe_send(websocket, json.dumps({"error": "invalid_item"}))
                    continue
                removed = [g for g in instance["ground_items"] if g["id"] == item_id]
                if removed:
                    instance["ground_items"].remove(removed[0])
                    save_world_state(server_id)
                    await broadcast_world_state(server_id)
                await safe_send(websocket, json.dumps({"ok": True, "type": "sync"}))
            elif operation == "get":
                player = load_player(player_id)
                await safe_send(
                    websocket,
                    json.dumps(
                        {
                            "data": get_player_data(player, server_id) if player else {},
                            "seed": instance["seed"],
                            "removed_trees": sorted(instance["removed_trees"]),
                            "ground_items": instance["ground_items"],
                            "players": collect_active_players_snapshot(server_id),
                        }
                    ),
                )
            else:
                await safe_send(websocket, json.dumps({"error": "unknown_operation"}))
    finally:
        CONNECTED_CLIENTS.setdefault(server_id, set()).discard(websocket)
        unregister_player_connection(server_id, player_id, websocket)
        WS_SEND_LOCKS.pop(id(websocket), None)
        if not PLAYER_CONNECTIONS.get(server_id, {}).get(player_id):
            LIVE_PLAYER_STATE.setdefault(server_id, {}).pop(player_id, None)
    return websocket


app.router.add_get("/", index)
app.router.add_get("/login", login)
app.router.add_post("/login", login)
app.router.add_get("/register", register)
app.router.add_post("/register", register)
app.router.add_get("/logout", logout)
app.router.add_get("/singleplayer", singleplayer)
app.router.add_get("/multiplayer", multiplayer)
app.router.add_get("/join/{server_id}", join_server)
app.router.add_post("/join/{server_id}", join_server)
app.router.add_get("/api/whoami", whoami)
app.router.add_get("/api/my-servers", my_servers)
app.router.add_get("/api/public-servers", public_servers)
app.router.add_post("/api/servers", create_server_handler)
app.router.add_delete("/api/servers/{server_id}", delete_server_handler)
app.router.add_get("/api/server/{server_id}", server_info)
app.router.add_get("/api/ws-token", ws_token)
app.router.add_get("/api/player-data", player_data)
app.router.add_get("/game", game)
app.router.add_get("/game/{tail:.*}", game)
app.router.add_get("/ws", websocket_handler)


def main():
    os.makedirs(PLAYERDATA_DIR, exist_ok=True)
    os.makedirs(GAME_DIR, exist_ok=True)
    os.makedirs(WORLDS_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", "8080"))
    print(f"Technogenesis server listening on port {port}")
    web.run_app(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()