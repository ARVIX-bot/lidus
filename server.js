const multer = require("multer");
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
    if (!value) return "был недавно";

    const last = new Date(value);
    const now = new Date();

    const sameDay =
        last.getFullYear() === now.getFullYear() &&
        last.getMonth() === now.getMonth() &&
        last.getDate() === now.getDate();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    const isYesterday =
        last.getFullYear() === yesterday.getFullYear() &&
        last.getMonth() === yesterday.getMonth() &&
        last.getDate() === yesterday.getDate();

    const time = last.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
    });

    if (sameDay) return "был в сети в " + time;
    if (isYesterday) return "был в сети вчера в " + time;

    return "был в сети " + last.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit"
    }) + " в " + time;
}

function pageHtml({ title, active, currentUser, body, rightPanel = "" }) {
    const avatar = currentUser?.avatar || "/images/logo.png";
    const username = currentUser?.username || "Lidus";

    const menu = [
        ["/feed", "fa-house", "Лента", "feed"],
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
        <link rel="stylesheet" href="/style.css?v=6001">
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

        const friendsResult = await pool.query(
            `SELECT u.id, u.username, u.login, u.avatar, u.last_seen
             FROM users u
             JOIN friends f ON f.friend_id = u.id
             WHERE f.user_id = $1
             ORDER BY u.username`,
            [currentUser.id]
        );

        const friends = friendsResult.rows;
        const avatar = currentUser.avatar || "/images/logo.png";

        const onlineList = friends.map(friend => `
            <div class="mini-user">
                <img src="${friend.avatar || "/images/logo.png"}" class="mini-avatar">
                <div><b>${friend.username}</b><p>${onlineUsers[friend.id] ? "🟢 Онлайн" : "⚫ Оффлайн"}</p></div>
            </div>
        `).join("");

        res.send(pageHtml({
            title: "Лента",
            active: "feed",
            currentUser,
            body: `
                <div class="mobile-app-header"><div class="mobile-app-title">Lidus</div><div class="mobile-app-actions"><a href="/users"><i class="fa-solid fa-magnifying-glass"></i></a><button type="button" class="primary"><i class="fa-solid fa-plus"></i></button></div></div>
                <div class="feed-title"><h1>Добро пожаловать, ${currentUser.username} 👋</h1><p>Лента новостей, друзья и активность Lidus</p></div>
                <div class="post-create pro-card"><img src="${avatar}" class="mini-avatar"><div class="post-input-area"><input placeholder="Что у вас нового?"><div class="post-tools"><button type="button"><i class="fa-regular fa-image"></i> Фото</button><button type="button"><i class="fa-regular fa-face-smile"></i> Настроение</button></div></div><button class="publish-btn">Опубликовать</button></div>
                <div class="post-card"><div class="post-header"><img src="${avatar}" class="mini-avatar"><div><b>${currentUser.username}</b><p>Сегодня</p></div></div><p>Продолжаю разработку Lidus Orbit 🚀</p><div class="post-actions"><span>❤️ 12</span><span>💬 4</span><span>↗️ 1</span></div></div>
                <div class="post-card"><div class="post-header"><img src="/images/logo.png" class="mini-avatar"><div><b>Lidus</b><p>Сегодня</p></div></div><p>PostgreSQL подключён. Старые JSON-файлы больше не нужны 🔥</p></div>
            `,
            rightPanel: `<div class="side-card"><h3>Онлайн друзья</h3>${onlineList || "<p>Нет друзей онлайн.</p>"}</div><div class="side-card"><h3>Уведомления</h3><p>🔔 Добро пожаловать в Lidus</p><p>👥 Друзья и чаты работают через PostgreSQL</p></div>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send("Ошибка загрузки ленты");
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
                ? `<span class="dialog-read-status ${d.read_at ? "is-read" : ""}">${d.read_at ? "✓✓" : "✓"}</span>`
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
            const readIcon = isMe ? `<span class="read-status" id="read-status-${msg.id}">${msg.read_at ? "✓✓" : "✓"}</span>` : "";
            return `<div class="message-row ${isMe ? "my-message" : "friend-message"}" data-message-id="${msg.id}"><div class="message-bubble"><b>${msg.sender_name}</b>${msg.text ? `<p>${msg.text}</p>` : ""}${photoHtml}<small>${time} ${readIcon}</small></div></div>`;
        }).join("");

        const friendOnline = !!onlineUsers[friend.id];
        const friendStatus = friendOnline ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#26d85d;vertical-align:middle;"></span>` : formatLastSeen(friend.last_seen);

        res.send(`
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
            <link rel="manifest" href="/manifest.json">
            <meta name="theme-color" content="#6b4dff">
            <title>Lidus — Диалог с ${friend.username}</title>
            <link rel="stylesheet" href="/style.css?v=6001">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
        </head>
        <body>
            <div class="app-layout">
                <aside class="left-menu"><div class="brand-logo"><div class="logo-app-icon">L</div><div class="logo-word">Lidus</div></div><a href="/feed"><i class="fa-solid fa-house"></i> Лента</a><a href="/profile"><i class="fa-solid fa-user"></i> Профиль</a><a href="/friends"><i class="fa-solid fa-user-group"></i> Друзья</a><a href="/users"><i class="fa-solid fa-magnifying-glass"></i> Найти людей</a><a href="/messages" class="active"><i class="fa-solid fa-comments"></i> Сообщения</a><a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Выйти</a></aside>
                <main class="feed"><div class="chat-page"><div class="chat-header"><a href="/messages" class="back-link"><i class="fa-solid fa-arrow-left"></i></a><img src="${friend.avatar || "/images/logo.png"}" class="chat-avatar"><div><h2>${friend.username}</h2><p id="status-${friend.id}">${friendStatus}</p><p id="typingStatus" class="typing-status" style="display:none;">печатает...</p></div></div><div id="messages" class="chat-messages">${list || "<p class='empty-chat'>Сообщений пока нет.</p>"}</div><form class="chat-form" id="chatForm" enctype="multipart/form-data"><label class="photo-btn" title="Отправить фото"><i class="fa-solid fa-image"></i><input type="file" id="photoInput" name="photos" accept="image/*" multiple hidden></label><div id="photoPreview" class="photo-preview-grid"></div><textarea id="messageInput" name="message" placeholder="Введите сообщение..." rows="1"></textarea><button type="submit"><i class="fa-solid fa-paper-plane"></i></button></form></div></main>
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

                function scrollChatBottom() { const messages = document.getElementById("messages"); requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; }); setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 100); }
                function escapeHtml(text) { const div = document.createElement("div"); div.innerText = text || ""; return div.innerHTML; }
                function addMessage(data) {
                    const messages = document.getElementById("messages");
                    const empty = document.querySelector(".empty-chat"); if (empty) empty.remove();
                    const row = document.createElement("div");
                    row.className = String(data.fromId) === String(currentUserId) ? "message-row my-message" : "message-row friend-message";
                    let content = "<div class='message-bubble'><b>" + escapeHtml(data.fromName) + "</b>";
                    if (data.text) content += "<p>" + escapeHtml(data.text) + "</p>";
                    if (data.photos && data.photos.length > 0) { content += "<div class='message-gallery'>"; data.photos.forEach(photo => { content += "<img src='" + photo + "' class='chat-photo'>"; }); content += "</div>"; }
                    const readStatus = String(data.fromId) === String(currentUserId)
                        ? " <span class='read-status' id='read-status-" + data.id + "'>" + (data.readAt ? "✓✓" : "✓") + "</span>"
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
                        if (el) el.innerText = "✓✓";
                    });
                });
                socket.on("online update", (onlineUsers) => {
                    const status = onlineUsers[friendId]
                        ? '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#26d85d;vertical-align:middle;"></span>'
                        : "был недавно";
                    const a = document.getElementById("status-" + friendId);
                    const b = document.getElementById("side-status-" + friendId);
                    if (a) a.innerHTML = status;
                    if (b) b.innerHTML = status;
                });

                const chatForm = document.getElementById("chatForm");
                const messageInput = document.getElementById("messageInput");
                const photoInput = document.getElementById("photoInput");
                const photoPreview = document.getElementById("photoPreview");
                messageInput.addEventListener("keydown", function(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); } });
                messageInput.addEventListener("input", function() {
                    this.style.height = "auto";
                    this.style.height = this.scrollHeight + "px";

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
                photoInput.addEventListener("change", () => { photoPreview.innerHTML = ""; const photos = Array.from(photoInput.files); if (photos.length === 0) { photoPreview.style.display = "none"; return; } photoPreview.style.display = "grid"; photos.forEach(photo => { const reader = new FileReader(); reader.onload = function(e) { const item = document.createElement("div"); item.className = "preview-item"; item.innerHTML = "<img src='" + e.target.result + "'><span>×</span>"; item.querySelector("span").addEventListener("click", () => { photoInput.value = ""; photoPreview.innerHTML = ""; photoPreview.style.display = "none"; }); photoPreview.appendChild(item); }; reader.readAsDataURL(photo); }); });
                chatForm.addEventListener("submit", async function(e) { e.preventDefault(); const text = messageInput.value.trim(); const photos = photoInput.files; if (!text && photos.length === 0) return; const formData = new FormData(); formData.append("message", text); for (let i = 0; i < photos.length; i++) formData.append("photos", photos[i]); messageInput.value = ""; messageInput.style.height = "auto"; photoInput.value = ""; photoPreview.innerHTML = ""; photoPreview.style.display = "none"; isTyping = false; socket.emit("typing", { dialogId, friendId, isTyping: false }); const response = await fetch("/send-message/" + friendId, { method: "POST", body: formData }); const result = await response.json(); if (result.success && result.message) addMessage(result.message); else alert("Ошибка отправки сообщения"); });
                function openPhoto(src) { document.getElementById("modalPhoto").src = src; document.getElementById("photoModal").style.display = "flex"; }
                function closePhoto() { document.getElementById("photoModal").style.display = "none"; }
                window.addEventListener("load", () => setTimeout(scrollChatBottom, 100));
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
