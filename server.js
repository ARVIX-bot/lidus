const multer = require("multer");
require("dotenv").config();
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const session = require("express-session");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const webpush = require("web-push");

const hasDatabase = !!process.env.DATABASE_URL;
const pool = hasDatabase
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:lewis_carolo63303@gmx.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        VAPID_SUBJECT,
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

async function initDb() {
    if (!hasDatabase) {
        console.log("DATABASE_URL не найден. На Render должен быть подключён PostgreSQL.");
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            login TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password TEXT NOT NULL,
            avatar TEXT DEFAULT '/images/logo.png',
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS friends (
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, friend_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            from_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            to_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            text TEXT,
            photos JSONB DEFAULT '[]',
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    await pool.query(`
        ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            type TEXT DEFAULT 'message',
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            endpoint TEXT UNIQUE NOT NULL,
            subscription JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS voice_rooms (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER REFERENCES voice_rooms(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            joined_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (room_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS room_invites (
            room_id INTEGER REFERENCES voice_rooms(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (room_id, user_id)
        );
    `);

    await pool.query(`
        ALTER TABLE voice_rooms
        ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(`
        ALTER TABLE voice_rooms
        ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT FALSE;
    `);

    console.log("PostgreSQL подключён, таблицы готовы");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const upload = multer({ dest: "public/avatars/" });
const messagePhotoUpload = multer({ dest: "public/message-photos/" });

fs.mkdirSync("public/message-photos", { recursive: true });
fs.mkdirSync("public/avatars", { recursive: true });

let onlineUsers = {};

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "lidus_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
});

app.use(sessionMiddleware);

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function requireAuth(req, res, next) {
    if (!req.session.userId) return res.redirect("/login.html");
    next();
}

async function getCurrentUser(req) {
    const result = await pool.query(
        `SELECT
            u.id,
            u.username,
            u.login,
            u.email,
            u.avatar,
            u.created_at,
            u.last_seen,
            (
                SELECT COUNT(*)::int
                FROM messages m
                WHERE m.to_id = u.id
                AND m.read_at IS NULL
            ) AS unread_total
         FROM users u
         WHERE u.id = $1`,
        [req.session.userId]
    );
    return result.rows[0];
}

function formatDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString("ru-RU");
}

function formatTime(value) {
    if (!value) return "";
    return new Date(value).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Moscow"
    });
}

function formatLastSeen(value) {
    if (!value) return "Был недавно";

    const last = new Date(value);
    const now = new Date();
    const diff = Math.floor((now - last) / 1000);

    if (diff < 60) return "Был в сети только что";

    if (diff < 3600) {
        const minutes = Math.floor(diff / 60);
        if (minutes === 1) return "Был в сети 1 минуту назад";
        if (minutes >= 2 && minutes <= 4) return `Был в сети ${minutes} минуты назад`;
        return `Был в сети ${minutes} минут назад`;
    }

    if (diff < 86400) {
        const hours = Math.floor(diff / 3600);
        if (hours === 1) return "Был в сети 1 час назад";
        if (hours >= 2 && hours <= 4) return `Был в сети ${hours} часа назад`;
        return `Был в сети ${hours} часов назад`;
    }

    const time = last.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Moscow"
    });

    const date = last.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "Europe/Moscow"
    });

    return `Был в сети ${date} в ${time}`;
}

function checkSvg(isRead) {
    return isRead
        ? `<svg class="msg-checks" viewBox="0 0 18 12" aria-hidden="true"><path d="M1 6L4 9L9 1"/><path d="M8 6L11 9L17 1"/></svg>`
        : `<svg class="msg-checks" viewBox="0 0 10 12" aria-hidden="true"><path d="M1 6L4 9L9 1"/></svg>`;
}

function escapeHtmlServer(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function linkifyMessageText(text) {
    const safe = escapeHtmlServer(text);
    return safe.replace(/(\/room\/\d+)/g, `<a class="message-room-link" href="$1">$1</a>`);
}


function pageHtml({ title, active, currentUser, body, rightPanel = "" }) {
    const avatar = currentUser?.avatar || "/images/logo.png";
    const username = currentUser?.username || "Lidus";

    const menu = [
        ["/feed", "fa-gamepad", "Игровая", "feed"],
        ["/profile", "fa-user", "Профиль", "profile"],
        ["/friends", "fa-user-group", "Друзья", "friends"],
        ["/users", "fa-magnifying-glass", "Найти людей", "users"],
        ["/messages", "fa-comments", "Сообщения", "messages"],
        ["/logout", "fa-right-from-bracket", "Выйти", "logout"]
    ].map(([href, icon, text, key]) => {
        const unreadBadge = key === "messages" && Number(currentUser?.unread_total || 0) > 0
            ? `<span class="nav-unread-badge">${Number(currentUser.unread_total) > 99 ? "99+" : currentUser.unread_total}</span>`
            : "";

        return `
        <a href="${href}" class="${active === key ? "active" : ""}">
            <span class="nav-link-inner"><i class="fa-solid ${icon}"></i> ${text}</span>${unreadBadge}
        </a>`;
    }).join("");

    return `
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
        <link rel="manifest" href="/manifest.json">
        <meta name="theme-color" content="#6b4dff">
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-title" content="Lidus">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <title>Lidus — ${title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="/style.css?v=6002">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    </head>
    <body>
        <div class="app-layout">
            <aside class="left-menu">
                <div class="brand-logo"><div class="logo-app-icon">L</div><div class="logo-word">Lidus</div></div>
                ${menu}
            </aside>
            <main class="feed">
                <div class="topbar">
                    <div class="search-box"><i class="fa-solid fa-magnifying-glass"></i><input placeholder="Поиск в Lidus"></div>
                    <div class="topbar-right">
                        <a class="top-icon top-icon-link" href="/notifications-page"><i class="fa-solid fa-bell"></i>${Number(currentUser?.unread_total || 0) > 0 ? `<span class="top-unread-badge">${Number(currentUser.unread_total) > 99 ? "99+" : currentUser.unread_total}</span>` : ""}</a>
                        <div class="top-icon"><i class="fa-solid fa-envelope"></i></div>
                        <div class="profile-mini"><img src="${avatar}" class="top-avatar"><span>${username}</span></div>
                    </div>
                </div>
                ${body}
            </main>
            <aside class="right-panel">${rightPanel}</aside>
        </div>
        <script src="/push.js?v=2"></script>
    </body>
    </html>`;
}


function isPushConfigured() {
    return !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

async function createNotification(userId, type, title, body, link) {
    if (!hasDatabase || !userId) return;

    try {
        await pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, type, title, body || "", link || "/notifications"]
        );
    } catch (error) {
        console.error("Ошибка создания уведомления:", error);
    }
}

async function sendPushNotification(userId, payload) {
    if (!isPushConfigured()) return;

    try {
        const result = await pool.query(
            `SELECT id, subscription FROM push_subscriptions WHERE user_id = $1`,
            [userId]
        );

        const data = JSON.stringify(payload);

        for (const row of result.rows) {
            try {
                await webpush.sendNotification(row.subscription, data);

                console.log(
                    "Push отправлен успешно:",
                    row.id,
                    "пользователь:",
                    userId
                );
            } catch (error) {
                if (
                    error.statusCode === 404 ||
                    error.statusCode === 410 ||
                    error.statusCode === 403
                ) {
                    console.error("APPLE PUSH ERROR:");
                    console.error("status:", error.statusCode);
                    console.error("body:", error.body);
                    console.error("endpoint:", row.subscription.endpoint);

                    await pool.query(
                        `DELETE FROM push_subscriptions WHERE id = $1`,
                        [row.id]
                    );

                    console.log("Старая push-подписка удалена:", row.id);
                } else {
                    console.error("Ошибка push уведомления:", error);
                }
            }
        }
    } catch (error) {
        console.error("Ошибка отправки push:", error);
    }
}


app.get("/vapid-public-key", requireAuth, (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

app.post("/save-subscription", requireAuth, async (req, res) => {
    if (!isPushConfigured()) {
        return res.status(503).json({ success: false, error: "Push не настроен на сервере" });
    }

    const subscription = req.body;

    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ success: false, error: "Нет push-подписки" });
    }

    try {
        await pool.query(
            `INSERT INTO push_subscriptions (user_id, endpoint, subscription)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (endpoint)
             DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription`,
            [req.session.userId, subscription.endpoint, JSON.stringify(subscription)]
        );

        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка сохранения push-подписки:", error);
        res.status(500).json({ success: false, error: "Ошибка сохранения подписки" });
    }
});

app.get("/notifications", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, type, title, body, link, is_read, created_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [req.session.userId]
        );

        res.json({ notifications: result.rows });
    } catch (error) {
        console.error("Ошибка получения уведомлений:", error);
        res.status(500).json({ notifications: [] });
    }
});

app.post("/notifications/read", requireAuth, async (req, res) => {
    try {
        await pool.query(
            `UPDATE notifications SET is_read = TRUE WHERE user_id = $1`,
            [req.session.userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка чтения уведомлений:", error);
        res.status(500).json({ success: false });
    }
});

app.get("/notifications-page", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const result = await pool.query(
            `SELECT id, type, title, body, link, is_read, created_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [currentUser.id]
        );

        const list = result.rows.map(n => `
            <a href="${n.link || "/messages"}" class="notification-item ${n.is_read ? "" : "is-unread"}">
                <div class="notification-dot"></div>
                <div class="notification-main">
                    <b>${n.title}</b>
                    <p>${n.body || "Новое уведомление"}</p>
                    <small>${formatDate(n.created_at)}</small>
                </div>
            </a>
        `).join("");

        await pool.query(`UPDATE notifications SET is_read = TRUE WHERE user_id = $1`, [currentUser.id]);

        res.send(pageHtml({
            title: "Уведомления",
            active: "messages",
            currentUser,
            body: `
                <div class="mobile-app-header"><div class="mobile-app-title">Уведомления</div><div class="mobile-app-actions"><a href="/messages"><i class="fa-solid fa-comments"></i></a></div></div>
                <section class="notifications-page">
                    <div class="messages-head"><h1>Уведомления</h1></div>
                    <div class="notifications-list">
                        ${list || "<div class='messages-empty'>Уведомлений пока нет</div>"}
                    </div>
                </section>
            `,
            rightPanel: `<div class="side-card"><h3>Уведомления</h3><p>Здесь появляются новые сообщения и события.</p></div>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка уведомлений");
    }
});

app.post("/register", async (req, res) => {
    const { username, login, email, password } = req.body;

    if (!username || !login || !password) return res.redirect("/register.html?error=empty");

    try {
        const existingUser = await pool.query("SELECT id FROM users WHERE login = $1 OR email = $2", [login, email || null]);
        if (existingUser.rows.length > 0) return res.redirect("/register.html?error=login_taken");

        const result = await pool.query(
            `INSERT INTO users (username, login, email, password, avatar)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, username, avatar`,
            [username, login, email || null, password, "/images/logo.png"]
        );

        const newUser = result.rows[0];
        req.session.userId = newUser.id;
        await pool.query(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [newUser.id]);
        onlineUsers[newUser.id] = true;
        io.emit("online update", onlineUsers);
        res.redirect("/feed");
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка регистрации");
    }
});

app.post("/login", async (req, res) => {
    const { login, password } = req.body;

    try {
        const result = await pool.query(`SELECT id, username, password FROM users WHERE login = $1`, [login]);
        const user = result.rows[0];

        if (!user || user.password !== password) return res.redirect("/login.html?error=wrong");

        req.session.userId = user.id;
        await pool.query(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [user.id]);
        onlineUsers[user.id] = true;
        io.emit("online update", onlineUsers);
        res.redirect("/feed");
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка входа");
    }
});

app.get("/logout", async (req, res) => {
    const userId = req.session.userId;

    if (userId) {
        delete onlineUsers[userId];

        try {
            await pool.query(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [userId]);
        } catch (error) {
            console.error("Ошибка обновления last_seen:", error);
        }
    }

    io.emit("online update", onlineUsers);
    req.session.destroy(() => res.redirect("/login.html"));
});

app.get("/feed", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        await pool.query(
    `INSERT INTO voice_rooms (name, description, owner_id, is_private, is_hidden)
     SELECT 'Общение', 'Свободная голосовая комната для друзей', $1, FALSE, FALSE
     WHERE NOT EXISTS (SELECT 1 FROM voice_rooms WHERE name = 'Общение')`,
    [currentUser.id]
);

await pool.query(
    `INSERT INTO voice_rooms (name, description, owner_id, is_private, is_hidden)
     SELECT 'Minecraft', 'Комната для игры и совместного выживания', $1, FALSE, FALSE
     WHERE NOT EXISTS (SELECT 1 FROM voice_rooms WHERE name = 'Minecraft')`,
    [currentUser.id]
);

await pool.query(
    `INSERT INTO voice_rooms (name, description, owner_id, is_private, is_hidden)
     SELECT 'Counter-Strike', 'Комната для каток и тимспика', $1, FALSE, FALSE
     WHERE NOT EXISTS (SELECT 1 FROM voice_rooms WHERE name = 'Counter-Strike')`,
    [currentUser.id]
);

        const roomsResult = await pool.query(
            `SELECT
                r.id,
                r.name,
                r.description,
                r.created_at,
                r.owner_id,
                r.is_private,
                r.is_hidden,
                u.username AS owner_name,
                COUNT(rm.user_id)::int AS members_count,
                EXISTS(
                    SELECT 1
                    FROM room_members my_rm
                    WHERE my_rm.room_id = r.id
                    AND my_rm.user_id = $1
                ) AS is_joined,
                EXISTS(
                    SELECT 1
                    FROM room_invites ri
                    WHERE ri.room_id = r.id
                    AND ri.user_id = $1
                ) AS is_invited
             FROM voice_rooms r
             LEFT JOIN users u ON u.id = r.owner_id
             LEFT JOIN room_members rm ON rm.room_id = r.id
             WHERE
                r.is_hidden = FALSE
                OR r.owner_id = $1
                OR EXISTS (
                    SELECT 1 FROM room_members my_rm
                    WHERE my_rm.room_id = r.id AND my_rm.user_id = $1
                )
                OR EXISTS (
                    SELECT 1 FROM room_invites ri
                    WHERE ri.room_id = r.id AND ri.user_id = $1
                )
             GROUP BY r.id, u.username
             ORDER BY r.id ASC`,
            [currentUser.id]
        );

        const totalMembers = roomsResult.rows.reduce((sum, room) => sum + Number(room.members_count || 0), 0);

        const roomCards = roomsResult.rows.map(room => `
            <div class="game-room-card ${room.is_joined ? "is-joined" : ""}">
                <div class="game-room-icon">
                    <i class="fa-solid ${room.name.toLowerCase().includes("minecraft") ? "fa-cube" : room.name.toLowerCase().includes("counter") ? "fa-crosshairs" : "fa-headset"}"></i>
                </div>

                <div class="game-room-main">
                    <div class="game-room-title">
                        <h3>${room.name}</h3>
                        ${room.is_joined ? `<span class="room-live-badge">Вы внутри</span>` : ""}
                        ${room.is_private ? `<span class="room-live-badge">Приватная</span>` : ""}
                        ${room.is_hidden ? `<span class="room-live-badge">Скрытая</span>` : ""}
                    </div>
                    <p>${room.description || "Голосовая комната Lidus"}</p>
                    <div class="game-room-meta">
                        <span><i class="fa-solid fa-users"></i> ${room.members_count} участников</span>
                        <span><i class="fa-solid fa-crown"></i> ${room.owner_name || "Lidus"}</span>
                    </div>
                </div>

                <a class="game-room-enter" href="/room/${room.id}">
                    <i class="fa-solid fa-right-to-bracket"></i>
                    Войти
                </a>
            </div>
        `).join("");

        res.send(pageHtml({
            title: "Игровая комната",
            active: "feed",
            currentUser,
            body: `
                <div class="mobile-app-header">
                    <div class="mobile-app-title">Игровая</div>
                    <div class="mobile-app-actions">
                        <button type="button" class="primary" onclick="document.getElementById('createRoomForm').classList.toggle('show')">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                    </div>
                </div>

                <section class="game-page">
                    <div class="game-hero">
                        <div>
                            <span class="game-kicker">Lidus Orbit</span>
                            <h1>🎮 Игровая комната</h1>
                            <p>Место для голосовых комнат, демонстрации экрана и будущих стримов для друзей.</p>
                        </div>
                        <div class="game-hero-stat">
                            <b>${totalMembers}</b>
                            <span>в комнатах</span>
                        </div>
                    </div>

                    <form id="createRoomForm" class="create-room-form" method="POST" action="/rooms/create">
                        <div>
                            <label>Название комнаты</label>
                            <input name="name" placeholder="Например: Dota 2, Minecraft, Общение" maxlength="40" required>
                        </div>
                        <div>
                            <label>Описание</label>
                            <input name="description" placeholder="Для чего эта комната?" maxlength="100">
                        </div>

                        <label class="room-checkbox">
                            <input type="checkbox" name="is_private">
                            <span>Приватная — вход только по приглашению</span>
                        </label>

                        <label class="room-checkbox">
                            <input type="checkbox" name="is_hidden">
                            <span>Скрытая — видна только участникам и приглашённым</span>
                        </label>

                        <button type="submit"><i class="fa-solid fa-plus"></i> Создать</button>
                    </form>

                    <div class="game-section-head">
                        <h2>Голосовые комнаты</h2>
                        <p>Сейчас это лобби комнат. Следующим шагом подключим WebRTC-голос.</p>
                    </div>

                    <div class="game-room-list">
                        ${roomCards || "<div class='messages-empty'>Комнат пока нет</div>"}
                    </div>
                </section>
            `,
            rightPanel: `
                <div class="side-card">
                    <h3>Игровая</h3>
                    <p>🎤 Голосовые комнаты</p>
                    <p>🖥 Скоро демонстрация экрана</p>
                    <p>📺 Потом стримы</p>
                </div>
                <div class="side-card">
                    <h3>Онлайн</h3>
                    <p>🟢 Сейчас в комнатах: ${totalMembers}</p>
                </div>
            `
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка игровой комнаты");
    }
});

app.post("/rooms/create", requireAuth, async (req, res) => {
    const name = (req.body.name || "").trim();
    const description = (req.body.description || "").trim();
    const isPrivate = req.body.is_private === "on";
    const isHidden = req.body.is_hidden === "on";

    if (!name) return res.redirect("/feed");

    try {
        const result = await pool.query(
            `INSERT INTO voice_rooms (name, description, owner_id, is_private, is_hidden)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [name.slice(0, 40), description.slice(0, 100), req.session.userId, isPrivate, isHidden]
        );

        await pool.query(
            `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [result.rows[0].id, req.session.userId]
        );

        res.redirect("/room/" + result.rows[0].id);
    } catch (error) {
        console.error("Ошибка создания комнаты:", error);
        res.status(500).send("Ошибка создания комнаты");
    }
});

app.get("/room/:id", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const roomResult = await pool.query(
            `SELECT r.id, r.name, r.description, r.created_at, r.owner_id, r.is_private, r.is_hidden, u.username AS owner_name
             FROM voice_rooms r
             LEFT JOIN users u ON u.id = r.owner_id
             WHERE r.id = $1`,
            [req.params.id]
        );

        const room = roomResult.rows[0];
        if (!room) return res.status(404).send("Комната не найдена");

        const accessResult = await pool.query(
            `SELECT
                EXISTS(SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2) AS is_member,
                EXISTS(SELECT 1 FROM room_invites WHERE room_id = $1 AND user_id = $2) AS is_invited`,
            [room.id, currentUser.id]
        );

        const access = accessResult.rows[0] || {};
        const isOwner = Number(room.owner_id) === Number(currentUser.id);
        const canAccessPrivateRoom = isOwner || access.is_member || access.is_invited;

        if (room.is_private && !canAccessPrivateRoom) {
            return res.status(403).send("Это приватная комната. Войти можно только по приглашению.");
        }

        await pool.query(
            `INSERT INTO room_members (room_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [room.id, currentUser.id]
        );

        const membersResult = await pool.query(
            `SELECT u.id, u.username, u.login, u.avatar, u.last_seen
             FROM room_members rm
             JOIN users u ON u.id = rm.user_id
             WHERE rm.room_id = $1
             ORDER BY rm.joined_at ASC`,
            [room.id]
        );

        const members = membersResult.rows;

        const membersHtml = members.map(member => `
            <div class="room-member" id="room-member-${member.id}">
                <img src="${member.avatar || "/images/logo.png"}">
                <div>
                    <b>${member.username}</b>
                    <span>${onlineUsers[member.id] ? "В сети" : formatLastSeen(member.last_seen)}</span>
                </div>
                <div class="room-member-dot ${onlineUsers[member.id] ? "is-online" : ""}"></div>
            </div>
        `).join("");

        res.send(pageHtml({
            title: room.name,
            active: "feed",
            currentUser,
            body: `
                <div class="mobile-app-header">
                    <div class="mobile-app-title">${room.name}</div>
                    <div class="mobile-app-actions">
                        <a href="/feed"><i class="fa-solid fa-arrow-left"></i></a>
                    </div>
                </div>

                <section class="room-page">
                    <div class="room-header-card">
                        <div>
                            <a class="room-back-link" href="/feed"><i class="fa-solid fa-arrow-left"></i> Назад</a>
                            <h1>🎤 ${room.name}</h1>
                            <p>${room.description || "Голосовая игровая комната Lidus"}</p>
                            <div class="room-privacy-badges">
                                <span><i class="fa-solid ${room.is_private ? "fa-lock" : "fa-lock-open"}"></i> ${room.is_private ? "Приватная" : "Публичная"}</span>
                                <span><i class="fa-solid ${room.is_hidden ? "fa-eye-slash" : "fa-eye"}"></i> ${room.is_hidden ? "Скрытая" : "Видна в списке"}</span>
                            </div>
                        </div>
                        <div class="room-header-actions">
                            ${Number(room.owner_id) === Number(currentUser.id) ? `
                            <button type="button" class="room-settings-gear" onclick="openRoomSettings()" title="Настройки комнаты">
                                <i class="fa-solid fa-gear"></i>
                            </button>
                            ` : ""}
                            <div class="room-count">
                                <b>${members.length}</b>
                                <span>участников</span>
                            </div>
                        </div>
                    </div>

                    <div class="voice-stage">
                        <div class="voice-stage-icon"><i class="fa-solid fa-headset"></i></div>
                        <h2>Голосовой чат скоро</h2>
                        <p>Комнаты уже работают. Следующим шагом подключим WebRTC: микрофон, мут, демонстрацию экрана и стрим.</p>

                        <div class="voice-controls">
                            <button type="button" class="voice-btn disabled"><i class="fa-solid fa-microphone"></i> Микрофон</button>
                            <button type="button" class="voice-btn disabled"><i class="fa-solid fa-volume-xmark"></i> Мут</button>
                            <button type="button" class="voice-btn disabled"><i class="fa-solid fa-display"></i> Экран</button>
                            <a class="voice-btn danger" href="/room/${room.id}/leave"><i class="fa-solid fa-door-open"></i> Выйти</a>
                        </div>
                    </div>

                    ${Number(room.owner_id) === Number(currentUser.id) ? `
                    <div id="roomSettingsModal" class="room-settings-modal" onclick="closeRoomSettings(event)">
                        <div class="room-settings-window">
                            <div class="room-settings-head">
                                <div>
                                    <h2><i class="fa-solid fa-gear"></i> Настройки комнаты</h2>
                                    <p>Приватность и приглашения для комнаты «${room.name}»</p>
                                </div>
                                <button type="button" class="room-settings-close" onclick="closeRoomSettings()">
                                    <i class="fa-solid fa-xmark"></i>
                                </button>
                            </div>

                            <form class="room-settings-form" method="POST" action="/room/${room.id}/settings">
                                <label class="room-toggle-row">
                                    <input type="checkbox" name="is_private" ${room.is_private ? "checked" : ""}>
                                    <span class="room-toggle-ui"></span>
                                    <div>
                                        <b>Приватная комната</b>
                                        <small>Войти смогут только участники и приглашённые.</small>
                                    </div>
                                </label>

                                <label class="room-toggle-row">
                                    <input type="checkbox" name="is_hidden" ${room.is_hidden ? "checked" : ""}>
                                    <span class="room-toggle-ui"></span>
                                    <div>
                                        <b>Скрыть из списка</b>
                                        <small>Комнату увидят только участники и приглашённые.</small>
                                    </div>
                                </label>

                                <button type="submit" class="room-save-btn"><i class="fa-solid fa-floppy-disk"></i> Сохранить настройки</button>
                            </form>

                            <div class="room-settings-divider"></div>

                            <form class="room-invite-form" method="POST" action="/room/${room.id}/invite">
                                <label>Пригласить друга</label>
                                <div class="room-invite-line">
                                    <input name="login" placeholder="Логин друга" required>
                                    <button type="submit"><i class="fa-solid fa-user-plus"></i> Пригласить</button>
                                </div>
                            </form>
                        </div>
                    </div>

                    <script>
                        function openRoomSettings() {
                            const modal = document.getElementById("roomSettingsModal");
                            if (modal) modal.classList.add("show");
                        }

                        function closeRoomSettings(event) {
                            if (event && event.target && event.target.id !== "roomSettingsModal") return;
                            const modal = document.getElementById("roomSettingsModal");
                            if (modal) modal.classList.remove("show");
                        }

                        document.addEventListener("keydown", function(event) {
                            if (event.key === "Escape") closeRoomSettings();
                        });
                    </script>
                    ` : ""}



                    <style>
                        .room-header-actions{display:flex;align-items:center;gap:14px;}
                        .room-settings-gear{width:52px;height:52px;border-radius:18px;padding:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);display:grid;place-items:center;font-size:20px;box-shadow:none;}
                        .room-settings-gear:hover{background:rgba(139,92,255,.22);transform:none;}
                        .room-privacy-badges{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
                        .room-privacy-badges span{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.07);color:#cfcfff;font-size:13px;font-weight:800;}
                        .room-settings-modal{position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(10px);z-index:999999;display:none;align-items:center;justify-content:center;padding:18px;}
                        .room-settings-modal.show{display:flex;}
                        .room-settings-window{width:min(560px,100%);border-radius:26px;background:#151724;border:1px solid rgba(255,255,255,.1);box-shadow:0 28px 90px rgba(0,0,0,.55);padding:22px;}
                        .room-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:18px;}
                        .room-settings-head h2{margin:0 0 6px;font-size:26px;}
                        .room-settings-head p{margin:0;color:#9c9caf;}
                        .room-settings-close{width:40px;height:40px;border-radius:14px;padding:0;background:rgba(255,255,255,.08);box-shadow:none;}
                        .room-toggle-row{display:grid;grid-template-columns:48px 1fr;gap:14px;align-items:center;padding:14px;border-radius:18px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);margin-bottom:12px;cursor:pointer;}
                        .room-toggle-row input{display:none;}
                        .room-toggle-ui{width:44px;height:26px;border-radius:999px;background:#2a2d3b;position:relative;transition:.2s;}
                        .room-toggle-ui:before{content:"";position:absolute;width:20px;height:20px;border-radius:50%;left:3px;top:3px;background:white;transition:.2s;}
                        .room-toggle-row input:checked + .room-toggle-ui{background:linear-gradient(135deg,#6b4dff,#9a6cff);}
                        .room-toggle-row input:checked + .room-toggle-ui:before{transform:translateX(18px);}
                        .room-toggle-row b{display:block;margin-bottom:3px;}
                        .room-toggle-row small{color:#9c9caf;}
                        .room-save-btn{width:100%;margin-top:4px;}
                        .room-settings-divider{height:1px;background:rgba(255,255,255,.08);margin:20px 0;}
                        .room-invite-form label{display:block;margin-bottom:9px;font-weight:900;}
                        .room-invite-line{display:flex;gap:10px;}
                        .room-invite-line input{flex:1;min-width:0;}
                        @media(max-width:768px){.room-header-actions{gap:8px}.room-settings-gear{width:44px;height:44px;border-radius:15px}.room-count{min-width:86px}.room-privacy-badges{gap:6px}.room-privacy-badges span{font-size:11px;padding:6px 8px}.room-settings-window{padding:18px;border-radius:22px}.room-settings-head h2{font-size:21px}.room-invite-line{flex-direction:column}.room-invite-line button{width:100%;}.room-toggle-row{grid-template-columns:44px 1fr;padding:12px}.room-toggle-row small{font-size:12px}}
                    </style>

                    <div class="room-members-card">
                        <h2>Участники</h2>
                        <div class="room-members-list">
                            ${membersHtml || "<p class='messages-empty'>В комнате пока никого нет</p>"}
                        </div>
                    </div>
                </section>
            `,
            rightPanel: `
                <div class="side-card">
                    <h3>${room.name}</h3>
                    <p>👑 Создал: ${room.owner_name || "Lidus"}</p>
                    <p>👥 Участников: ${members.length}</p><p>🔒 ${room.is_private ? "Приватная" : "Публичная"}</p><p>👁 ${room.is_hidden ? "Скрытая" : "Видна в списке"}</p>
                </div>
                <div class="side-card">
                    <h3>Следующий этап</h3>
                    <p>🎤 WebRTC голос</p>
                    <p>🖥 Демонстрация экрана</p>
                </div>
            `
        }));
    } catch (error) {
        console.error("Ошибка комнаты:", error);
        res.status(500).send("Ошибка комнаты");
    }
});

app.post("/room/:id/settings", requireAuth, async (req, res) => {
    try {
        const roomResult = await pool.query(`SELECT id, owner_id FROM voice_rooms WHERE id = $1`, [req.params.id]);
        const room = roomResult.rows[0];

        if (!room) return res.status(404).send("Комната не найдена");
        if (Number(room.owner_id) !== Number(req.session.userId)) {
            return res.status(403).send("Настройки может менять только владелец комнаты");
        }

        const isPrivate = req.body.is_private === "on";
        const isHidden = req.body.is_hidden === "on";

        await pool.query(
            `UPDATE voice_rooms SET is_private = $1, is_hidden = $2 WHERE id = $3`,
            [isPrivate, isHidden, room.id]
        );

        res.redirect("/room/" + room.id);
    } catch (error) {
        console.error("Ошибка настроек комнаты:", error);
        res.status(500).send("Ошибка настроек комнаты");
    }
});

app.post("/room/:id/invite", requireAuth, async (req, res) => {
    const login = (req.body.login || "").trim();

    if (!login) return res.redirect("/room/" + req.params.id);

    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const roomResult = await pool.query(
            `SELECT id, name, owner_id FROM voice_rooms WHERE id = $1`,
            [req.params.id]
        );
        const room = roomResult.rows[0];

        if (!room) return res.status(404).send("Комната не найдена");
        if (Number(room.owner_id) !== Number(currentUser.id)) {
            return res.status(403).send("Приглашать может только владелец комнаты");
        }

        const userResult = await pool.query(
            `SELECT id, username, login FROM users WHERE login = $1`,
            [login]
        );
        const invitedUser = userResult.rows[0];

        if (!invitedUser) return res.status(404).send("Пользователь не найден");
        if (Number(invitedUser.id) === Number(currentUser.id)) {
            return res.redirect("/room/" + room.id);
        }

        await pool.query(
            `INSERT INTO room_invites (room_id, user_id, invited_by)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [room.id, invitedUser.id, currentUser.id]
        );

        const inviteText = `🎮 ${currentUser.username} пригласил тебя в комнату «${room.name}». Нажми и перейди: /room/${room.id}`;
        const insertResult = await pool.query(
            `INSERT INTO messages (from_id, to_id, text, photos)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id, created_at, read_at`,
            [currentUser.id, invitedUser.id, inviteText, JSON.stringify([])]
        );

        const dialogId = [currentUser.id, invitedUser.id].sort().join("-");
        const messageForClient = {
            id: insertResult.rows[0].id,
            dialogId,
            fromId: currentUser.id,
            fromName: currentUser.username,
            text: inviteText,
            photos: [],
            time: formatTime(insertResult.rows[0].created_at),
            readAt: insertResult.rows[0].read_at
        };

        io.to(dialogId).emit("private message", messageForClient);

        await createNotification(
            invitedUser.id,
            "room_invite",
            "Приглашение в комнату",
            `${currentUser.username} пригласил вас в «${room.name}»`,
            "/room/" + room.id
        );

        await sendPushNotification(invitedUser.id, {
            title: "Приглашение в комнату",
            body: `${currentUser.username} пригласил вас в «${room.name}»`,
            url: "/room/" + room.id,
            icon: currentUser.avatar || "/assets/icon-192.png",
            badge: "/assets/icon-192.png"
        });

        res.redirect("/room/" + room.id);
    } catch (error) {
        console.error("Ошибка приглашения в комнату:", error);
        res.status(500).send("Ошибка приглашения в комнату");
    }
});

app.get("/room/:id/leave", requireAuth, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`,
            [req.params.id, req.session.userId]
        );

        res.redirect("/feed");
    } catch (error) {
        console.error("Ошибка выхода из комнаты:", error);
        res.redirect("/feed");
    }
});

app.get("/profile", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const friendsCountResult = await pool.query(`SELECT COUNT(*)::int AS count FROM friends WHERE user_id = $1`, [currentUser.id]);
        const friendsCount = friendsCountResult.rows[0].count;
        const avatar = currentUser.avatar || "/images/logo.png";

        res.send(pageHtml({
            title: "Профиль",
            active: "profile",
            currentUser,
            body: `
                <div class="mobile-app-header"><div class="mobile-app-title">Профиль</div><div class="mobile-app-actions"><button type="button" class="primary"><i class="fa-solid fa-gear"></i></button></div></div>
                <div class="feed-title"><h1>Профиль</h1><p>Ваш аккаунт и личная информация</p></div>
                <div class="profile-page-card">
                    <div class="profile-cover"></div>
                    <div class="profile-main"><img class="profile-avatar-big" src="${avatar}"><div class="profile-info"><h1>${currentUser.username}</h1><p class="muted">@${currentUser.login}</p><p class="profile-status">🟢 Онлайн</p></div></div>
                    <div class="profile-stats"><div><b>${currentUser.id}</b><span>ID</span></div><div><b>${friendsCount}</b><span>Друзей</span></div><div><b>${formatDate(currentUser.created_at)}</b><span>Дата регистрации</span></div></div>
                    <form class="avatar-form" method="POST" action="/upload-avatar" enctype="multipart/form-data"><label>Обновить аватар</label><input type="file" name="avatar" accept="image/*" required><button type="submit"><i class="fa-solid fa-camera"></i> Загрузить</button></form>
                </div>
            `,
            rightPanel: `<div class="side-card"><h3>Аккаунт</h3><p>👤 ${currentUser.username}</p><p>🆔 ID: ${currentUser.id}</p><p>👥 Друзей: ${friendsCount}</p></div><div class="side-card"><h3>Подсказка</h3><p>📷 Можно загрузить новую аватарку</p><p>💬 Сообщения доступны через меню</p></div>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка профиля");
    }
});

app.post("/upload-avatar", requireAuth, upload.single("avatar"), async (req, res) => {
    if (!req.file) return res.redirect("/profile");

    try {
        const avatarPath = "/avatars/" + req.file.filename;
        await pool.query(`UPDATE users SET avatar = $1 WHERE id = $2`, [avatarPath, req.session.userId]);
        res.redirect("/profile");
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка загрузки аватара");
    }
});

app.get("/users", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const usersResult = await pool.query(
            `SELECT u.id, u.username, u.login, u.avatar,
                    EXISTS(SELECT 1 FROM friends f WHERE f.user_id = $1 AND f.friend_id = u.id) AS already_friend
             FROM users u
             WHERE u.id != $1
             ORDER BY u.id DESC`,
            [currentUser.id]
        );

        const users = usersResult.rows;
        const list = users.map(user => `
            <div class="friend-card">
                <img src="${user.avatar || "/images/logo.png"}" class="friend-avatar">
                <div class="friend-info"><h3>${user.username}</h3><p>@${user.login}</p><p>ID: ${user.id}</p><p>${onlineUsers[user.id] ? "🟢 Онлайн" : "⚫ Оффлайн"}</p></div>
                ${user.already_friend ? `<a href="/dialog/${user.id}"><button><i class="fa-solid fa-message"></i> Написать</button></a>` : `<a href="/add-friend/${user.id}"><button><i class="fa-solid fa-user-plus"></i> Добавить</button></a>`}
            </div>
        `).join("");

        res.send(pageHtml({
            title: "Найти людей",
            active: "users",
            currentUser,
            body: `<div class="feed-title"><h1>Найти людей</h1><p>Найдите друзей и начните общение</p></div><div class="friends-list">${list || "<div class='post-card'><p>Пока других пользователей нет.</p></div>"}</div>`,
            rightPanel: `<div class="side-card"><h3>Пользователи</h3><p>👥 Доступно: ${users.length}</p></div><div class="side-card"><h3>Подсказка</h3><p>👥 Добавьте пользователя в друзья</p><p>💬 После этого можно писать сообщения</p></div>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка списка пользователей");
    }
});

app.get("/add-friend/:id", requireAuth, async (req, res) => {
    const currentUserId = Number(req.session.userId);
    const targetUserId = Number(req.params.id);

    if (!targetUserId || currentUserId === targetUserId) return res.redirect("/users");

    try {
        const target = await pool.query(`SELECT id FROM users WHERE id = $1`, [targetUserId]);
        if (target.rows.length === 0) return res.status(404).send("Пользователь не найден");

        await pool.query(
            `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [currentUserId, targetUserId]
        );
        await pool.query(
            `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [targetUserId, currentUserId]
        );

        res.redirect("/friends");
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка добавления друга");
    }
});

app.get("/friends", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const friendsResult = await pool.query(
            `SELECT u.id, u.username, u.login, u.avatar, u.last_seen
             FROM users u
             JOIN friends f ON f.friend_id = u.id
             WHERE f.user_id = $1
             ORDER BY u.username`,
            [currentUser.id]
        );

        const friends = friendsResult.rows;
        const list = friends.map(friend => `
            <div class="friend-card">
                <img src="${friend.avatar || "/images/logo.png"}" class="friend-avatar">
                <div class="friend-info"><h3>${friend.username}</h3><p>@${friend.login}</p><p>ID: ${friend.id}</p><p id="status-${friend.id}">${onlineUsers[friend.id] ? "🟢 Онлайн" : "⚫ Оффлайн"}</p></div>
                <a href="/dialog/${friend.id}"><button><i class="fa-solid fa-message"></i> Написать</button></a>
            </div>
        `).join("");

        res.send(pageHtml({
            title: "Друзья",
            active: "friends",
            currentUser,
            body: `
                <div class="mobile-app-header"><div class="mobile-app-title">Друзья</div><div class="mobile-app-actions"><a href="/users"><i class="fa-solid fa-user-plus"></i></a></div></div>
                <div class="feed-title"><h1>Друзья</h1><p>Ваш список друзей и онлайн-статусы</p></div>
                <div class="friends-list">${list || "<div class='post-card'><p>У вас пока нет друзей.</p></div>"}</div>
                <script src="/socket.io/socket.io.js"></script>
                <script>
                    const socket = io();
                    socket.on("online update", (onlineUsers) => {
                        document.querySelectorAll("[id^='status-']").forEach(el => {
                            const id = el.id.replace("status-", "");
                            el.innerText = onlineUsers[id] ? "🟢 Онлайн" : "⚫ Оффлайн";
                        });
                    });
                </script>
            `,
            rightPanel: `<div class="side-card"><h3>Статистика</h3><p>👥 Друзей: ${friends.length}</p><p>🟢 Онлайн: ${friends.filter(f => onlineUsers[f.id]).length}</p></div><div class="side-card"><h3>Подсказка</h3><p>🔍 Найдите людей через поиск</p><p>💬 Пишите друзьям в личные сообщения</p></div>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка друзей");
    }
});

app.get("/messages", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const dialogsResult = await pool.query(
            `
            WITH last_messages AS (
                SELECT DISTINCT ON (
                    CASE
                        WHEN from_id = $1 THEN to_id
                        ELSE from_id
                    END
                )
                    CASE
                        WHEN from_id = $1 THEN to_id
                        ELSE from_id
                    END AS friend_id,
                    id AS message_id,
                    from_id,
                    to_id,
                    text,
                    photos,
                    created_at,
                    read_at
                FROM messages
                WHERE from_id = $1 OR to_id = $1
                ORDER BY
                    CASE
                        WHEN from_id = $1 THEN to_id
                        ELSE from_id
                    END,
                    created_at DESC
            )
            SELECT
                u.id,
                u.username,
                u.login,
                u.avatar,
                u.last_seen,
                lm.message_id,
                lm.from_id,
                lm.to_id,
                lm.text,
                lm.photos,
                lm.created_at,
                lm.read_at,
                (
                    SELECT COUNT(*)::int
                    FROM messages um
                    WHERE um.from_id = u.id
                    AND um.to_id = $1
                    AND um.read_at IS NULL
                ) AS unread_count
            FROM users u
            JOIN last_messages lm ON lm.friend_id = u.id
            ORDER BY lm.created_at DESC
            `,
            [currentUser.id]
        );

        const friendsResult = await pool.query(
            `SELECT u.id, u.username, u.login, u.avatar, u.last_seen
             FROM users u
             JOIN friends f ON f.friend_id = u.id
             WHERE f.user_id = $1
             ORDER BY u.username`,
            [currentUser.id]
        );

        const dialogMap = new Map();
        dialogsResult.rows.forEach(d => dialogMap.set(d.id, d));
        friendsResult.rows.forEach(f => {
            if (!dialogMap.has(f.id)) dialogMap.set(f.id, f);
        });

        const dialogs = Array.from(dialogMap.values());

        const list = dialogs.map(d => {
            const photos = Array.isArray(d.photos) ? d.photos : [];
            const unreadCount = Number(d.unread_count || 0);
            const isUnread = unreadCount > 0;
            const isMyLastMessage = Number(d.from_id) === Number(currentUser.id);
            const readIcon = isMyLastMessage
                ? `<span class="dialog-read-status ${d.read_at ? "is-read" : ""}">${checkSvg(!!d.read_at)}</span>`
                : "";
            const lastText = d.text && d.text.trim()
                ? d.text
                : (photos.length ? "📷 Фото" : "Начните диалог");
            const onlineDot = onlineUsers[d.id] ? `<span class="dialog-online-dot"></span>` : "";
            const unreadBadge = isUnread
                ? `<div class="dialog-unread-badge">${unreadCount > 99 ? "99+" : unreadCount}</div>`
                : "";

            return `
                <a href="/dialog/${d.id}" class="dialog-row ${isUnread ? "has-unread" : ""}">
                    <div class="dialog-avatar-wrap">
                        <img src="${d.avatar || "/images/logo.png"}" class="dialog-row-avatar">
                        ${onlineDot}
                    </div>

                    <div class="dialog-row-main">
                        <div class="dialog-row-name">${d.username}</div>
                        <div class="dialog-row-preview">${lastText}</div>
                    </div>

                    <div class="dialog-row-meta">
                        <div class="dialog-row-time">${d.created_at ? formatTime(d.created_at) : ""}</div>
                        <div class="dialog-row-checks">${unreadBadge || readIcon}</div>
                    </div>
                </a>
            `;
        }).join("");

        res.send(pageHtml({
            title: "Сообщения",
            active: "messages",
            currentUser,
            body: `
                <section class="messages-page">
                    <div class="messages-head">
                        <h1>Сообщения</h1>
                        <div class="messages-head-actions">
                            <button type="button" class="messages-icon-btn"><i class="fa-solid fa-ellipsis"></i></button>
                            <a href="/users" class="messages-icon-btn primary"><i class="fa-solid fa-plus"></i></a>
                        </div>
                    </div>

                    <div class="messages-searchbar">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input placeholder="Люди, чаты и сообщения">
                    </div>

                    <div class="messages-tabs">
                        <button class="active" type="button">Все</button>
                        <button type="button">Новые</button>
                        <button type="button">Каналы</button>
                    </div>

                    <div class="messages-list">
                        ${list || "<div class='messages-empty'>Добавьте друга и начните диалог</div>"}
                    </div>
                </section>
            `,
            rightPanel: `<div class="side-card"><h3>Статистика</h3><p>💬 Диалогов: ${dialogs.length}</p></div><div class="side-card"><h3>Подсказка</h3><p>👥 Добавляйте новых друзей</p><p>🔒 Сообщения приватны</p></div>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка сообщений");
    }
});



app.get("/dialog/:id", requireAuth, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return req.session.destroy(() => res.redirect("/login.html"));

        const friendResult = await pool.query(`SELECT id, username, login, avatar, last_seen FROM users WHERE id = $1`, [req.params.id]);
        const friend = friendResult.rows[0];
        if (!friend) return res.status(404).send("Пользователь не найден");

        const readResult = await pool.query(
            `UPDATE messages
             SET read_at = NOW()
             WHERE from_id = $1 AND to_id = $2 AND read_at IS NULL
             RETURNING id`,
            [friend.id, currentUser.id]
        );

        const dialogId = [currentUser.id, friend.id].sort().join("-");
        if (readResult.rows.length > 0) {
            io.to(dialogId).emit("messages read", {
                readerId: currentUser.id,
                messageIds: readResult.rows.map(row => row.id)
            });
        }

        const messagesResult = await pool.query(
            `SELECT m.id, m.from_id, m.to_id, m.text, m.photos, m.created_at, m.read_at, u.username AS sender_name
             FROM messages m
             JOIN users u ON u.id = m.from_id
             WHERE (m.from_id = $1 AND m.to_id = $2) OR (m.from_id = $2 AND m.to_id = $1)
             ORDER BY m.created_at ASC`,
            [currentUser.id, friend.id]
        );

        const list = messagesResult.rows.map(msg => {
            const isMe = msg.from_id === currentUser.id;
            const photos = Array.isArray(msg.photos) ? msg.photos : [];
            const photoHtml = photos.length ? `<div class="message-gallery">${photos.map(photo => `<img src="${photo}" class="chat-photo" onclick="openPhoto(this.src)">`).join("")}</div>` : "";
            const time = formatTime(msg.created_at);
            const readIcon = isMe ? `<span class="read-status ${msg.read_at ? "is-read" : ""}" id="read-status-${msg.id}">${checkSvg(!!msg.read_at)}</span>` : "";
            return `<div class="message-row ${isMe ? "my-message" : "friend-message"}" data-message-id="${msg.id}"><div class="message-bubble"><b>${msg.sender_name}</b>${msg.text ? `<p>${linkifyMessageText(msg.text)}</p>` : ""}${photoHtml}<small>${time} ${readIcon}</small></div></div>`;
        }).join("");

        const friendOnline = !!onlineUsers[friend.id];
        const friendStatus = friendOnline ? "В сети" : formatLastSeen(friend.last_seen);

        res.send(`
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
            <link rel="manifest" href="/manifest.json">
            <meta name="theme-color" content="#6b4dff">
            <title>Lidus — Диалог с ${friend.username}</title>
            <link rel="stylesheet" href="/style.css?v=6002">
            <link rel="stylesheet" href="/chat.css?v=3">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
            <style>.message-room-link{display:inline-block;margin-top:5px;padding:7px 10px;border-radius:12px;background:rgba(255,255,255,.14);color:#fff;text-decoration:none;font-weight:900}.message-room-link:hover{background:rgba(255,255,255,.22)}</style>
        </head>
        <body class="dialog-body">
            <div class="app-layout">
                <aside class="left-menu"><div class="brand-logo"><div class="logo-app-icon">L</div><div class="logo-word">Lidus</div></div><a href="/feed"><i class="fa-solid fa-house"></i> Лента</a><a href="/profile"><i class="fa-solid fa-user"></i> Профиль</a><a href="/friends"><i class="fa-solid fa-user-group"></i> Друзья</a><a href="/users"><i class="fa-solid fa-magnifying-glass"></i> Найти людей</a><a href="/messages" class="active"><i class="fa-solid fa-comments"></i> Сообщения</a><a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Выйти</a></aside>
                <main class="feed"><div class="chat-page"><div class="chat-header"><a href="/messages" class="back-link"><i class="fa-solid fa-arrow-left"></i></a><img src="${friend.avatar || "/images/logo.png"}" class="chat-avatar"><div><h2>${friend.username}</h2><p id="status-${friend.id}">${friendStatus}</p><p id="typingStatus" class="typing-status" style="display:none;">печатает...</p></div></div><div id="messages" class="chat-messages">${list || "<p class='empty-chat'>Сообщений пока нет.</p>"}</div><form class="chat-form" id="chatForm" enctype="multipart/form-data" onsubmit="sendChatMessageStable(event); return false;"><label class="photo-btn" title="Отправить фото"><i class="fa-solid fa-image"></i><input type="file" id="photoInput" name="photos" accept="image/*" multiple hidden></label><div id="photoPreview" class="photo-preview-grid"></div><input id="messageInput" name="message" placeholder="Введите сообщение..." autocomplete="off"><button type="button" id="sendMessageBtn" onclick="sendChatMessageStable(event)"><i class="fa-solid fa-paper-plane"></i></button></form></div></main>
                <aside class="right-panel"><div class="side-card"><h3>Диалог</h3><p>👤 ${friend.username}</p><p id="side-status-${friend.id}">${friendStatus}</p></div><div class="side-card"><h3>Приватность</h3><p>🔒 Этот диалог видите только вы двое</p><p>💬 Сообщения сохраняются в PostgreSQL</p></div></aside>
            </div>
            <div id="photoModal" class="photo-modal" onclick="closePhoto()"><img id="modalPhoto"></div>
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const dialogId = "${dialogId}";
                const currentUserId = "${currentUser.id}";
                const friendId = "${friend.id}";
                let typingTimer = null;
                let isTyping = false;
                socket.emit("join dialog", { dialogId, friendId });

                function playMessageSound() {
                    try {
                        const AudioContext = window.AudioContext || window.webkitAudioContext;
                        const ctx = new AudioContext();
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.type = "sine";
                        osc.frequency.value = 720;
                        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
                        gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.015);
                        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.start();
                        osc.stop(ctx.currentTime + 0.2);
                    } catch (e) {}
                }

                function scrollChatBottom() { const messages = document.getElementById("messages"); if (!messages) return; const go = () => { messages.scrollTop = messages.scrollHeight; document.documentElement.scrollTop = document.documentElement.scrollHeight; document.body.scrollTop = document.body.scrollHeight; }; go(); requestAnimationFrame(go); setTimeout(go, 50); setTimeout(go, 150); setTimeout(go, 500); }
                function escapeHtml(text) { const div = document.createElement("div"); div.innerText = text || ""; return div.innerHTML; }
                function getCheckSvg(isRead) {
                    return isRead
                        ? '<svg class="msg-checks" viewBox="0 0 18 12" aria-hidden="true"><path d="M1 6L4 9L9 1"/><path d="M8 6L11 9L17 1"/></svg>'
                        : '<svg class="msg-checks" viewBox="0 0 10 12" aria-hidden="true"><path d="M1 6L4 9L9 1"/></svg>';
                }
                function addMessage(data) {
                    const messages = document.getElementById("messages");
                    const empty = document.querySelector(".empty-chat"); if (empty) empty.remove();
                    const row = document.createElement("div");
                    row.className = String(data.fromId) === String(currentUserId) ? "message-row my-message" : "message-row friend-message";
                    let content = "<div class='message-bubble'><b>" + escapeHtml(data.fromName) + "</b>";
                    function linkifyRoomLinks(text) { return escapeHtml(text).replace(/(\/room\/\d+)/g, "<a class='message-room-link' href='$1'>$1</a>"); }
                    if (data.text) content += "<p>" + linkifyRoomLinks(data.text) + "</p>";
                    if (data.photos && data.photos.length > 0) { content += "<div class='message-gallery'>"; data.photos.forEach(photo => { content += "<img src='" + photo + "' class='chat-photo'>"; }); content += "</div>"; }
                    const readStatus = String(data.fromId) === String(currentUserId)
                        ? " <span class='read-status " + (data.readAt ? "is-read" : "") + "' id='read-status-" + data.id + "'>" + getCheckSvg(!!data.readAt) + "</span>"
                        : "";
                    content += "<small>" + data.time + readStatus + "</small></div>";
                    if (data.id) row.dataset.messageId = data.id;
                    row.innerHTML = content;
                    row.querySelectorAll(".chat-photo").forEach(img => { img.addEventListener("click", () => openPhoto(img.src)); img.onload = scrollChatBottom; });
                    messages.appendChild(row); scrollChatBottom();
                }
                socket.on("private message", (data) => {
                    if (String(data.fromId) !== String(currentUserId)) {
                        addMessage(data);
                        playMessageSound();
                    }
                });

                socket.on("typing", (data) => {
                    if (String(data.userId) !== String(friendId)) return;
                    const typing = document.getElementById("typingStatus");
                    const status = document.getElementById("status-" + friendId);
                    if (!typing || !status) return;

                    if (data.isTyping) {
                        status.style.display = "none";
                        typing.style.display = "block";
                    } else {
                        typing.style.display = "none";
                        status.style.display = "block";
                    }
                });
                socket.on("messages read", (data) => {
                    if (String(data.readerId) === String(currentUserId)) return;
                    if (!Array.isArray(data.messageIds)) return;
                    data.messageIds.forEach(id => {
                        const el = document.getElementById("read-status-" + id);
                        if (el) { el.classList.add("is-read"); el.innerHTML = getCheckSvg(true); }
                    });
                });
                socket.on("online update", (onlineUsers) => {
                    const status = onlineUsers[friendId]
                        ? "В сети"
                        : "Был в сети только что";
                    const a = document.getElementById("status-" + friendId);
                    const b = document.getElementById("side-status-" + friendId);
                    if (a) a.innerHTML = status;
                    if (b) b.innerHTML = status;
                });

                socket.on("user status update", (data) => {
                    if (!data || String(data.userId) !== String(friendId)) return;
                    const a = document.getElementById("status-" + friendId);
                    const b = document.getElementById("side-status-" + friendId);
                    const text = data.status || "Был в сети только что";
                    if (a) a.innerHTML = text;
                    if (b) b.innerHTML = text;
                });

                const chatForm = document.getElementById("chatForm");
                const messageInput = document.getElementById("messageInput");
                const photoInput = document.getElementById("photoInput");
                const photoPreview = document.getElementById("photoPreview");
                const sendMessageBtn = document.getElementById("sendMessageBtn");
                let isSendingMessage = false;

                async function sendChatMessageStable(event) {
                    if (event) {
                        event.preventDefault();
                        event.stopPropagation();
                    }

                    if (isSendingMessage) return false;

                    const text = (messageInput.value || "").trim();
                    const photos = photoInput.files || [];
                    if (!text && photos.length === 0) return false;

                    isSendingMessage = true;
                    if (sendMessageBtn) sendMessageBtn.disabled = true;

                    const formData = new FormData();
                    formData.append("message", text);
                    for (let i = 0; i < photos.length; i++) formData.append("photos", photos[i]);

                    const oldText = messageInput.value;
                    messageInput.value = "";
                    photoInput.value = "";
                    photoPreview.innerHTML = "";
                    photoPreview.style.display = "none";
                    isTyping = false;
                    socket.emit("typing", { dialogId, friendId, isTyping: false });

                    try {
                        const response = await fetch("/send-message/" + friendId, {
                            method: "POST",
                            body: formData,
                            credentials: "same-origin"
                        });

                        const result = await response.json();

                        if (result.success && result.message) {
                            addMessage(result.message);
                            scrollChatBottom();
                        } else {
                            messageInput.value = oldText;
                            alert(result.error || "Ошибка отправки сообщения");
                        }
                    } catch (error) {
                        messageInput.value = oldText;
                        console.error("Ошибка отправки сообщения:", error);
                        alert("Ошибка отправки сообщения");
                    } finally {
                        isSendingMessage = false;
                        if (sendMessageBtn) sendMessageBtn.disabled = false;
                        messageInput.focus();
                        scrollChatBottom();
                    }

                    return false;
                }

                window.sendChatMessageStable = sendChatMessageStable;

                chatForm.addEventListener("submit", sendChatMessageStable);

                messageInput.addEventListener("keydown", function(e) {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        sendChatMessageStable(e);
                    }
                });

                messageInput.addEventListener("input", function() {
                    if (!isTyping) {
                        isTyping = true;
                        socket.emit("typing", { dialogId, friendId, isTyping: true });
                    }

                    clearTimeout(typingTimer);
                    typingTimer = setTimeout(() => {
                        isTyping = false;
                        socket.emit("typing", { dialogId, friendId, isTyping: false });
                    }, 1400);
                });

                photoInput.addEventListener("change", () => {
                    photoPreview.innerHTML = "";
                    const photos = Array.from(photoInput.files || []);
                    if (photos.length === 0) {
                        photoPreview.style.display = "none";
                        return;
                    }

                    photoPreview.style.display = "grid";
                    photos.forEach(photo => {
                        const reader = new FileReader();
                        reader.onload = function(e) {
                            const item = document.createElement("div");
                            item.className = "preview-item";
                            item.innerHTML = "<img src='" + e.target.result + "'><span>×</span>";
                            item.querySelector("span").addEventListener("click", () => {
                                photoInput.value = "";
                                photoPreview.innerHTML = "";
                                photoPreview.style.display = "none";
                            });
                            photoPreview.appendChild(item);
                        };
                        reader.readAsDataURL(photo);
                    });
                });

                function openPhoto(src) { document.getElementById("modalPhoto").src = src; document.getElementById("photoModal").style.display = "flex"; }
                function closePhoto() { document.getElementById("photoModal").style.display = "none"; }
                window.addEventListener("load", () => {
                    scrollChatBottom();
                    setTimeout(scrollChatBottom, 100);
                    setTimeout(scrollChatBottom, 500);
                    setTimeout(scrollChatBottom, 1000);
                });
            </script>
            <script src="/push.js?v=2"></script>
        </body>
        </html>`);
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка диалога");
    }
});

app.post("/send-message/:id", requireAuth, messagePhotoUpload.array("photos", 10), async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (!currentUser) return res.status(401).json({ success: false, error: "Не авторизован" });

        const friendResult = await pool.query(`SELECT id, username FROM users WHERE id = $1`, [req.params.id]);
        const friend = friendResult.rows[0];
        if (!friend) return res.status(404).json({ success: false, error: "Пользователь не найден" });

        const photos = req.files ? req.files.map(file => "/message-photos/" + file.filename) : [];
        const text = req.body.message || "";

        const insertResult = await pool.query(
            `INSERT INTO messages (from_id, to_id, text, photos)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id, created_at, read_at`,
            [currentUser.id, friend.id, text, JSON.stringify(photos)]
        );

        const dialogId = [currentUser.id, friend.id].sort().join("-");
        const newMessageId = insertResult.rows[0].id;
        let readAt = insertResult.rows[0].read_at;

        const roomSockets = await io.in(dialogId).fetchSockets();
        const friendHasDialogOpen = roomSockets.some(s =>
            Number(s.userId) === Number(friend.id) &&
            String(s.activeDialogId) === String(dialogId)
        );

        if (friendHasDialogOpen) {
            const readResult = await pool.query(
                `UPDATE messages
                 SET read_at = NOW()
                 WHERE id = $1
                 RETURNING read_at`,
                [newMessageId]
            );

            readAt = readResult.rows[0]?.read_at || readAt;
        }

        const messageForClient = {
            id: newMessageId,
            dialogId,
            fromId: currentUser.id,
            fromName: currentUser.username,
            text,
            photos,
            time: formatTime(insertResult.rows[0].created_at),
            readAt
        };

        io.to(dialogId).emit("private message", messageForClient);

        const pushText = text && text.trim() ? text.trim() : (photos.length ? "📷 Фото" : "Новое сообщение");
        const notificationTitle = currentUser.username;
        const notificationBody = pushText.length > 80 ? pushText.slice(0, 80) + "…" : pushText;
        const notificationLink = "/dialog/" + currentUser.id;

        await createNotification(friend.id, "message", notificationTitle, notificationBody, notificationLink);

        if (!friendHasDialogOpen) {
            await sendPushNotification(friend.id, {
                title: notificationTitle,
                body: notificationBody,
                url: notificationLink,
                icon: currentUser.avatar || "/assets/icon-192.png",
                badge: "/assets/icon-192.png"
            });
        }

        if (readAt) {
            io.to(dialogId).emit("messages read", {
                readerId: friend.id,
                messageIds: [newMessageId]
            });
        }

        res.json({ success: true, message: messageForClient });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Ошибка отправки сообщения" });
    }
});

io.on("connection", (socket) => {
    console.log("Socket.IO подключён");

    const connectedUserId = Number(socket.request.session?.userId);
    if (connectedUserId) {
        socket.userId = connectedUserId;
        onlineUsers[connectedUserId] = true;
        io.emit("online update", onlineUsers);
    }

    socket.on("join dialog", async (data) => {
        const dialogId = typeof data === "string" ? data : data?.dialogId;
        const friendId = Number(data?.friendId);
        const userId = Number(socket.request.session?.userId);

        if (!dialogId || !userId) return;

        socket.join(dialogId);
        socket.userId = userId;
        socket.activeDialogId = dialogId;
        socket.activeFriendId = friendId || null;

        if (friendId) {
            try {
                const readResult = await pool.query(
                    `UPDATE messages
                     SET read_at = NOW()
                     WHERE from_id = $1 AND to_id = $2 AND read_at IS NULL
                     RETURNING id`,
                    [friendId, userId]
                );

                if (readResult.rows.length > 0) {
                    io.to(dialogId).emit("messages read", {
                        readerId: userId,
                        messageIds: readResult.rows.map(row => row.id)
                    });
                }
            } catch (error) {
                console.error("Ошибка отметки прочтения:", error);
            }
        }
    });

    socket.on("typing", (data) => {
        const dialogId = data?.dialogId;
        const userId = Number(socket.userId || socket.request.session?.userId);
        if (!dialogId || !userId) return;

        socket.to(dialogId).emit("typing", {
            userId,
            isTyping: !!data.isTyping
        });
    });

    socket.on("disconnect", async () => {
        const userId = Number(socket.userId || socket.request.session?.userId);
        if (!userId) return;

        const stillOnline = Array.from(await io.fetchSockets()).some(s =>
            Number(s.userId || s.request.session?.userId) === Number(userId)
        );

        if (!stillOnline) {
            delete onlineUsers[userId];

            try {
                await pool.query(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [userId]);
            } catch (error) {
                console.error("Ошибка обновления last_seen:", error);
            }

            io.emit("online update", onlineUsers);
            io.emit("user status update", {
                userId,
                status: "Был в сети только что"
            });
        }
    });
});


const PORT = process.env.PORT || 3000;

initDb().then(() => {
    server.listen(PORT, () => console.log(`Lidus запущен на порту ${PORT}`));
}).catch(error => {
    console.error("Ошибка запуска Lidus:", error);
    process.exit(1);
});
