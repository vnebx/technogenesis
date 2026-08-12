import asyncio
import json
import os
import secrets
import threading
import uuid
from datetime import datetime, timezone
from functools import wraps

import websockets
from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PLAYERDATA_DIR = os.path.join(BASE_DIR, "playerdata")
PLAYERLOGIN_PATH = os.path.join(BASE_DIR, "playerlogin.json")
GAME_DIR = os.path.join(BASE_DIR, "game")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
WORLD_SEED_LENGTH = 24
MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT = 1
CONNECTED_CLIENTS = set()
PLAYER_CONNECTIONS = {}

app = Flask(__name__, template_folder=TEMPLATES_DIR)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

file_lock = threading.Lock()
ws_serializer = URLSafeTimedSerializer(app.config["SECRET_KEY"], salt="ws-auth")
SERVER_STATE = {"seed": None}


def load_playerlogin():
    with file_lock:
        if not os.path.exists(PLAYERLOGIN_PATH):
            return {"users": {}}
        with open(PLAYERLOGIN_PATH, "r", encoding="utf-8") as f:
            return json.load(f)


def save_playerlogin(data):
    os.makedirs(os.path.dirname(PLAYERLOGIN_PATH), exist_ok=True)
    with file_lock:
        with open(PLAYERLOGIN_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)


def player_file_path(player_id):
    return os.path.join(PLAYERDATA_DIR, f"{player_id}.json")


def load_player(player_id):
    path = player_file_path(player_id)
    if not os.path.exists(path):
        return None
    with file_lock:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)


def save_player(player_id, data):
    os.makedirs(PLAYERDATA_DIR, exist_ok=True)
    with file_lock:
        with open(player_file_path(player_id), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)


def get_client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "player_id" not in session:
            return redirect(url_for("login"))
        return view(*args, **kwargs)

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


def get_world_seed():
    if SERVER_STATE["seed"] is None:
        SERVER_STATE["seed"] = generate_world_seed()
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
        player = load_player(player_id)
        if player is not None:
            players[player_id] = build_player_state(player_id, player)
    return players


async def broadcast_world_state():
    payload = {
        "type": "state",
        "seed": get_world_seed(),
        "players": collect_active_players_snapshot(),
    }
    for websocket in list(CONNECTED_CLIENTS):
        try:
            await websocket.send(json.dumps(payload))
        except Exception:
            pass


@app.route("/")
def index():
    if "player_id" in session:
        return redirect(url_for("game"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if "player_id" in session:
        return redirect(url_for("game"))

    if request.method == "GET":
        return render_template("login.html", error=None)

    username = request.form.get("username", "").strip().lower()
    password = request.form.get("password", "")

    data = load_playerlogin()
    user = data["users"].get(username)
    if user is None or not check_password_hash(user["password_hash"], password):
        return render_template("login.html", error="Invalid username or password.")

    if len(active_player_connections(user["player_id"])) >= MAX_ACTIVE_CONNECTIONS_PER_ACCOUNT:
        return render_template("login.html", error="This account is already logged in from another session.")

    client_ip = get_client_ip()
    user["last_ip"] = client_ip
    save_playerlogin(data)

    session["player_id"] = user["player_id"]
    session["username"] = username
    session["ws_token"] = generate_ws_token(user["player_id"])
    return redirect(url_for("game"))


@app.route("/register", methods=["GET", "POST"])
def register():
    if "player_id" in session:
        return redirect(url_for("game"))

    if request.method == "GET":
        return render_template("register.html", error=None)

    username = request.form.get("username", "").strip().lower()
    password = request.form.get("password", "")

    if not validate_username(username):
        return render_template(
            "register.html",
            error="Username must be 3-32 alphanumeric characters.",
        )
    if not validate_password(password):
        return render_template(
            "register.html",
            error="Password must be at least 8 characters.",
        )

    data = load_playerlogin()
    if username in data["users"]:
        return render_template("register.html", error="Username already taken.")

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
            },
        },
    )

    session["player_id"] = player_id
    session["username"] = username
    session["ws_token"] = generate_ws_token(player_id)
    return redirect(url_for("game"))


@app.route("/api/ws-token")
@login_required
def ws_token():
    return jsonify({"token": session["ws_token"]})


@app.route("/api/player-data")
@login_required
def player_data():
    player = load_player(session["player_id"])
    if player is None:
        return jsonify({"data": {}})
    return jsonify({"data": player.get("data", {})})


@app.route("/game/")
@app.route("/game/<path:filename>")
@login_required
def game(filename="index.html"):
    player = load_player(session["player_id"])
    if player is None:
        session.clear()
        return redirect(url_for("login"))
    return send_from_directory(GAME_DIR, filename)


def run_flask():
    os.makedirs(PLAYERDATA_DIR, exist_ok=True)
    os.makedirs(GAME_DIR, exist_ok=True)
    app.run(host="0.0.0.0", port=5000, use_reloader=False)


async def networkloop(websocket):
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
        auth_msg = json.loads(raw)
        token = auth_msg.get("token")
    except (asyncio.TimeoutError, json.JSONDecodeError):
        await websocket.close(code=4001, reason="Auth required")
        return

    player_id = verify_ws_token(token)
    if player_id is None or load_player(player_id) is None:
        await websocket.close(code=4003, reason="Unauthorized")
        return

    if not register_player_connection(player_id, websocket):
        await websocket.close(code=4004, reason="Max active sessions reached")
        return

    CONNECTED_CLIENTS.add(websocket)
    try:
        welcome = {
            "type": "welcome",
            "seed": get_world_seed(),
            "player_id": player_id,
            "players": collect_active_players_snapshot(),
        }
        await websocket.send(json.dumps(welcome))

        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({"error": "invalid_json"}))
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

                player["data"] = {
                    "position": position,
                    "animation": animation,
                    "character": character,
                }
                save_player(player_id, player)
                await broadcast_world_state()
                await websocket.send(json.dumps({"ok": True, "type": "sync"}))
            elif operation == "get":
                player = load_player(player_id)
                await websocket.send(json.dumps({"data": player.get("data", {}), "seed": get_world_seed(), "players": collect_active_players_snapshot()}))
            else:
                await websocket.send(json.dumps({"error": "unknown_operation"}))
    finally:
        CONNECTED_CLIENTS.discard(websocket)
        unregister_player_connection(player_id, websocket)


async def main():
    async with websockets.serve(networkloop, "0.0.0.0", 8900):
        print("WebSocket server running on port 8900")
        await asyncio.Future()


if __name__ == "__main__":
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    asyncio.run(main())
