const multer = require("multer");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const session = require("express-session");

const { Pool } = require("pg");

const hasDatabase = !!process.env.DATABASE_URL;

const pool = hasDatabase
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })
    : null;

async function initDb() {

    if (!hasDatabase) return;

    

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

    console.log("PostgreSQL подключён, таблицы готовы");
}

const app = express();

const upload = multer({
    dest: "public/avatars/"
});

const messagePhotoUpload = multer({
    dest: "public/message-photos/"
});

let onlineUsers = {};
const server = http.createServer(app);
const io = new Server(server);

fs.mkdirSync("public/message-photos", { recursive: true });
fs.mkdirSync("public/avatars", { recursive: true });


app.use(session({
    secret: "lidus_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30
    }
}));

app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static("public"));

app.post("/register", async (req, res) => {

    const { username, login, email, password } = req.body;

    try {
        const existingUser = await pool.query(
            "SELECT id FROM users WHERE login = $1",
            [login]
        );

        if (existingUser.rows.length > 0) {
            return res.redirect("/register.html?error=login_taken");
        }

        const result = await pool.query(
            `
            INSERT INTO users (username, login, email, password, avatar)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, username, avatar
            `,
            [
                username,
                login,
                email || null,
                password,
                "/images/logo.png"
            ]
        );

        const newUser = result.rows[0];

        req.session.userId = newUser.id;

        onlineUsers[newUser.id] = true;

        io.emit("online update", onlineUsers);

        res.redirect("/feed");

    } catch (error) {
        console.error(error);
        res.send("Ошибка регистрации");
    }

});


app.post("/login", async (req, res) => {

    const { login, password } = req.body;

    try {
        const result = await pool.query(
            `
            SELECT id, username, password
            FROM users
            WHERE login = $1
            `,
            [login]
        );

        const user = result.rows[0];

        if (!user || user.password !== password) {
            return res.redirect("/login.html?error=wrong");
        }

        req.session.userId = user.id;

        onlineUsers[user.id] = true;

        io.emit("online update", onlineUsers);

        res.redirect("/feed");

    } catch (error) {
        console.error(error);
        res.send("Ошибка входа");
    }

});


app.get("/profile", (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));

    const currentUser = users.find(
    u => u.id === req.session.userId
);

    res.send(`
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <title>Lidus — Профиль</title>

        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">

        <link rel="stylesheet" href="/style.css?v=1000">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    </head>

    <body>
        <div class="app-layout">

            <aside class="left-menu">
                <div class="brand-logo">
                    <div class="logo-app-icon">L</div>
                    <div class="logo-word">Lidus</div>
                </div>

                <a href="/feed">
                    <i class="fa-solid fa-house"></i>
                    Лента
                </a>

                <a href="/profile" class="active">
                    <i class="fa-solid fa-user"></i>
                    Профиль
                </a>

                <a href="/friends">
                    <i class="fa-solid fa-user-group"></i>
                    Друзья
                </a>

                <a href="/users">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    Найти людей
                </a>

                <a href="/messages">
                    <i class="fa-solid fa-comments"></i>
                    Сообщения
                </a>

                <a href="/logout">
                    <i class="fa-solid fa-right-from-bracket"></i>
                    Выйти
                </a>

                
            </aside>

            <main class="feed">

                <div class="topbar">

                    <div class="search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input placeholder="Поиск в Lidus">
                    </div>

                    <div class="topbar-right">

                        <div class="top-icon">
                            <i class="fa-solid fa-bell"></i>
                        </div>

                        <div class="top-icon">
                            <i class="fa-solid fa-envelope"></i>
                        </div>

                        <div class="profile-mini">
                            <img src="${avatar}" class="top-avatar">
                            <span>${currentUser.username}</span>
                        </div>

                    </div>

                </div>

                <div class="mobile-app-header">
    <div class="mobile-app-title">Профиль</div>

    <div class="mobile-app-actions">
        <button type="button" class="primary">
            <i class="fa-solid fa-gear"></i>
        </button>
    </div>
</div>
                
                <div class="feed-title">
                    <h1>Профиль</h1>
                    <p>Ваш аккаунт и личная информация</p>
                </div>

                <div class="profile-page-card">

                    <div class="profile-cover"></div>

                    <div class="profile-main">
                        <img class="profile-avatar-big" src="${avatar}">

                        <div class="profile-info">
                            <h1>${currentUser.username}</h1>
                            <p class="muted">@${currentUser.username.toLowerCase()}</p>
                            <p class="profile-status">🟢 Онлайн</p>
                        </div>
                    </div>

                    <div class="profile-stats">
                        <div>
                            <b>${currentUser.id}</b>
                            <span>ID</span>
                        </div>

                        <div>
                            <b>${currentUser.friends.length}</b>
                            <span>Друзей</span>
                        </div>

                        <div>
                            <b>${currentUser.createdAt}</b>
                            <span>Дата регистрации</span>
                        </div>
                    </div>

                    <form class="avatar-form" method="POST" action="/upload-avatar" enctype="multipart/form-data">
                        <label>Обновить аватар</label>
                        <input type="file" name="avatar" accept="image/*" required>
                        <button type="submit">
                            <i class="fa-solid fa-camera"></i>
                            Загрузить
                        </button>
                    </form>

                </div>

            </main>

            <aside class="right-panel">

                <div class="side-card">
                    <h3>Аккаунт</h3>
                    <p>👤 ${currentUser.username}</p>
                    <p>🆔 ID: ${currentUser.id}</p>
                    <p>👥 Друзей: ${currentUser.friends.length}</p>
                </div>

                <div class="side-card">
                    <h3>Подсказка</h3>
                    <p>📷 Можно загрузить новую аватарку</p>
                    <p>💬 Сообщения доступны через меню</p>
                </div>

            </aside>

        </div>
    </body>
    </html>
    `);
});
app.get("/logout", (req, res) => {

    const users = JSON.parse(fs.readFileSync("data/users.json"));

    const user = users.find(
        u => u.id === req.session.userId
    );

    if (user) {
        delete onlineUsers[user.username];
    }

    io.emit("online update", onlineUsers);

    req.session.destroy(() => {
        res.redirect("/login.html");
    });

});


app.get("/users", (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));

    const currentUser = users.find(
        u => u.id === req.session.userId
    );

    const otherUsers = users.filter(
        u => u.id !== currentUser.id
    );

    let list = "";

    otherUsers.forEach(user => {

        const alreadyFriend = currentUser.friends.includes(user.id);

        list += `
            <div class="friend-card">
                <img src="${user.avatar}" class="friend-avatar">

                <div class="friend-info">
                    <h3>${user.username}</h3>
                    <p>ID: ${user.id}</p>
                    <p>${onlineUsers[user.username] ? "🟢 Онлайн" : "⚫ Оффлайн"}</p>
                </div>

                ${
                    alreadyFriend
                    ? `
                        <a href="/dialog/${user.id}">
                            <button>
                                <i class="fa-solid fa-message"></i>
                                Написать
                            </button>
                        </a>
                    `
                    : `
                        <a href="/add-friend/${user.id}">
                            <button>
                                <i class="fa-solid fa-user-plus"></i>
                                Добавить
                            </button>
                        </a>
                    `
                }
            </div>
        `;
    });

    res.send(`
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <title>Lidus — Найти людей</title>

        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">

        <link rel="stylesheet" href="/style.css?v=1000">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    </head>

    <body>
        <div class="app-layout">

            <aside class="left-menu">
                <div class="brand-logo">
                    <div class="logo-app-icon">L</div>
                    <div class="logo-word">Lidus</div>
                </div>

                <a href="/feed">
                    <i class="fa-solid fa-house"></i>
                    Лента
                </a>

                <a href="/profile">
                    <i class="fa-solid fa-user"></i>
                    Профиль
                </a>

                <a href="/friends">
                    <i class="fa-solid fa-user-group"></i>
                    Друзья
                </a>

                <a href="/users" class="active">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    Найти людей
                </a>

                <a href="/messages">
                    <i class="fa-solid fa-comments"></i>
                    Сообщения
                </a>

                <a href="/logout">
                    <i class="fa-solid fa-right-from-bracket"></i>
                    Выйти
                </a>

                
            </aside>

            <main class="feed">

                <div class="topbar">

                    <div class="search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input placeholder="Поиск пользователей">
                    </div>

                    <div class="topbar-right">

                        <div class="top-icon">
                            <i class="fa-solid fa-bell"></i>
                        </div>

                        <div class="top-icon">
                            <i class="fa-solid fa-envelope"></i>
                        </div>

                        <div class="profile-mini">
                            <img src="${avatar}" class="top-avatar">
                            <span>${currentUser.username}</span>
                        </div>

                    </div>

                </div>

                <div class="feed-title">
                    <h1>Найти людей</h1>
                    <p>Найдите друзей и начните общение</p>
                </div>

                <div class="friends-list">
                    ${list || "<div class='post-card'><p>Пока других пользователей нет.</p></div>"}
                </div>

            </main>

            <aside class="right-panel">

                <div class="side-card">
                    <h3>Пользователи</h3>
                    <p>👥 Всего: ${users.length}</p>
                    <p>🔍 Доступно: ${otherUsers.length}</p>
                </div>

                <div class="side-card">
                    <h3>Подсказка</h3>
                    <p>👥 Добавьте пользователя в друзья</p>
                    <p>💬 После этого можно писать сообщения</p>
                </div>

            </aside>

        </div>
    </body>
    </html>
    `);
});

app.get("/add-friend/:id", (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(
        fs.readFileSync("data/users.json")
    );

    const currentUser = users.find(
    u => u.id === req.session.userId
);

    const targetUser = users.find(
        u => u.id == req.params.id
    );

    if (!targetUser) {
        return res.send("Пользователь не найден");
    }

    if (!currentUser.friends.includes(targetUser.id)) {
        currentUser.friends.push(targetUser.id);
    }

    fs.writeFileSync(
        "data/users.json",
        JSON.stringify(users, null, 2)
    );

    req.session.userId = newUser.id;

onlineUsers[newUser.id] = true;

io.emit("online update", onlineUsers);

res.redirect("/feed");

});

app.get("/friends", (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));

    const currentUser = users.find(
    u => u.id === req.session.userId
);

    const friends = users.filter(
        u => currentUser.friends.includes(u.id)
    );

    let list = "";

    friends.forEach(friend => {

        const status = onlineUsers[friend.username]
            ? "🟢 Онлайн"
            : "⚫ Оффлайн";

        list += `
            <div class="friend-card">
                <img src="${friend.avatar}" class="friend-avatar">

                <div class="friend-info">
                    <h3>${friend.username}</h3>
                    <p>ID: ${friend.id}</p>
                    <p id="status-${friend.username}">${status}</p>
                </div>

                <a href="/dialog/${friend.id}">
                    <button>
                        <i class="fa-solid fa-message"></i>
                        Написать
                    </button>
                </a>
            </div>
        `;
    });

    res.send(`
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <title>Lidus — Друзья</title>

        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">

        <link rel="stylesheet" href="/style.css?v=1000">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    </head>

    <body>
        <div class="app-layout">

            <aside class="left-menu">
                <div class="brand-logo">
                    <div class="logo-app-icon">L</div>
                    <div class="logo-word">Lidus</div>
                </div>

                <a href="/feed">
                    <i class="fa-solid fa-house"></i>
                    Лента
                </a>

                <a href="/profile">
                    <i class="fa-solid fa-user"></i>
                    Профиль
                </a>

                <a href="/friends" class="active">
                    <i class="fa-solid fa-user-group"></i>
                    Друзья
                </a>

                <a href="/users">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    Найти людей
                </a>

                <a href="/messages">
                    <i class="fa-solid fa-comments"></i>
                    Сообщения
                </a>

                <a href="/logout">
                    <i class="fa-solid fa-right-from-bracket"></i>
                    Выйти
                </a>

                
            </aside>

            <main class="feed">

                <div class="topbar">

                    <div class="search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input placeholder="Поиск среди друзей">
                    </div>

                    <div class="topbar-right">

                        <div class="top-icon">
                            <i class="fa-solid fa-bell"></i>
                        </div>

                        <div class="top-icon">
                            <i class="fa-solid fa-envelope"></i>
                        </div>

                        <div class="profile-mini">
                            <img src="${avatar}" class="top-avatar">
                            <span>${currentUser.username}</span>
                        </div>

                    </div>

                </div>
                <div class="mobile-app-header">
    <div class="mobile-app-title">Друзья</div>

    <div class="mobile-app-actions">
        <a href="/users">
            <i class="fa-solid fa-user-plus"></i>
        </a>
    </div>
</div>

                <div class="feed-title">
                    <h1>Друзья</h1>
                    <p>Ваш список друзей и онлайн-статусы</p>
                </div>

                <div class="friends-list">
                    ${list || "<div class='post-card'><p>У вас пока нет друзей.</p></div>"}
                </div>

            </main>

            <aside class="right-panel">

                <div class="side-card">
                    <h3>Статистика</h3>
                    <p>👥 Друзей: ${friends.length}</p>
                    <p>🟢 Онлайн: ${
                        friends.filter(friend => onlineUsers[friend.username]).length
                    }</p>
                </div>

                <div class="side-card">
                    <h3>Подсказка</h3>
                    <p>🔍 Найдите людей через поиск</p>
                    <p>💬 Пишите друзьям в личные сообщения</p>
                </div>

            </aside>

        </div>

        <script src="/socket.io/socket.io.js"></script>

        <script>
            const socket = io();

            socket.on("online update", (onlineUsers) => {

                document.querySelectorAll("[id^='status-']").forEach(el => {

                    const username = el.id.replace("status-", "");

                    if (onlineUsers[username]) {
                        el.innerText = "🟢 Онлайн";
                    } else {
                        el.innerText = "⚫ Оффлайн";
                    }

                });

            });
        </script>

    </body>
    </html>
    `);
});


app.get("/dialog/:id", (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));
    const messages = JSON.parse(fs.readFileSync("data/messages.json"));

    const currentUser = users.find(
    u => u.id === req.session.userId
);
    const friend = users.find(u => u.id == req.params.id);

    if (!friend) {
        return res.send("Пользователь не найден");
    }

    const dialogMessages = messages.filter(msg =>
        (msg.from === currentUser.id && msg.to === friend.id) ||
        (msg.from === friend.id && msg.to === currentUser.id)
    );

    let list = "";

    dialogMessages.forEach(msg => {
        const sender = users.find(u => u.id === msg.from);
        const isMe = msg.from === currentUser.id;

        const textHtml = msg.text ? `<p>${msg.text}</p>` : "";
        const photoHtml = msg.photos && msg.photos.length > 0
    ? `<div class="message-gallery">${
        msg.photos.map(photo =>
            `<img src="${photo}" class="chat-photo" onclick="openPhoto(this.src)">`
        ).join("")
    }</div>`
    : "";

        list += `
            <div class="message-row ${isMe ? "my-message" : "friend-message"}">
                <div class="message-bubble">
                    <b>${sender.username}</b>
                    ${textHtml}
                    ${photoHtml}
                    <small>${msg.date}</small>
                </div>
            </div>
        `;
    });

    const dialogId = [currentUser.id, friend.id].sort().join("-");
    const friendStatus = onlineUsers[friend.username] ? "🟢 Онлайн" : "⚫ Оффлайн";

    res.send(`
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
    <link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <title>Lidus — Диалог с ${friend.username}</title>

        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">

        <link rel="stylesheet" href="/style.css?v=1000">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    </head>

    <body>
        <div class="app-layout">

            <aside class="left-menu">
                <div class="brand-logo">
                    <div class="logo-app-icon">L</div>
                    <div class="logo-word">Lidus</div>
                </div>

                <a href="/feed">
                    <i class="fa-solid fa-house"></i>
                    Лента
                </a>

                <a href="/profile">
                    <i class="fa-solid fa-user"></i>
                    Профиль
                </a>

                <a href="/friends">
                    <i class="fa-solid fa-user-group"></i>
                    Друзья
                </a>

                <a href="/users">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    Найти людей
                </a>

                <a href="/messages" class="active">
                    <i class="fa-solid fa-comments"></i>
                    Сообщения
                </a>

                <a href="/logout">
                    <i class="fa-solid fa-right-from-bracket"></i>
                    Выйти
                </a>

                
            </aside>

            <main class="feed">

                <div class="chat-page">

                    <div class="chat-header">
                        <a href="/messages" class="back-link">
                            <i class="fa-solid fa-arrow-left"></i>
                        </a>

                        <img src="${friend.avatar}" class="chat-avatar">

                        <div>
                            <h2>${friend.username}</h2>
                            <p id="status-${friend.username}">${friendStatus}</p>
                        </div>
                    </div>

                    <div id="messages" class="chat-messages">
                        ${list || "<p class='empty-chat'>Сообщений пока нет.</p>"}
                    </div>

                    <form class="chat-form" id="chatForm" enctype="multipart/form-data">
    <label class="photo-btn" title="Отправить фото">
        <i class="fa-solid fa-image"></i>
        <input
    type="file"
    id="photoInput"
    name="photos"
    accept="image/*"
    multiple
    hidden>
    </label>

    <div id="photoPreview" class="photo-preview-grid"></div>

    <textarea id="messageInput" name="message" placeholder="Введите сообщение..." rows="1"></textarea>

    <button type="submit">
        <i class="fa-solid fa-paper-plane"></i>
    </button>
</form>

                </div>

            </main>

            <aside class="right-panel">

                <div class="side-card">
                    <h3>Диалог</h3>
                    <p>👤 ${friend.username}</p>
                    <p id="side-status-${friend.username}">${friendStatus}</p>
                </div>

                <div class="side-card">
                    <h3>Приватность</h3>
                    <p>🔒 Этот диалог видите только вы двое</p>
                    <p>💬 Сообщения сохраняются в истории</p>
                </div>

            </aside>

        </div>

        <div id="photoModal" class="photo-modal" onclick="closePhoto()">
            <img id="modalPhoto">
        </div>

        <script src="/socket.io/socket.io.js"></script>

<script>
    const socket = io();
    const dialogId = "${dialogId}";
    const currentUserId = "${currentUser.id}";
    const friendUsername = "${friend.username}";
    const friendId = "${friend.id}";

    socket.emit("join dialog", dialogId);

    function scrollChatBottom() {
    const messages = document.getElementById("messages");

    requestAnimationFrame(() => {
        messages.scrollTop = messages.scrollHeight;
    });

    setTimeout(() => {
        messages.scrollTop = messages.scrollHeight;
    }, 100);

    setTimeout(() => {
        messages.scrollTop = messages.scrollHeight;
    }, 300);
}

    function addMessage(data) {
        const messages = document.getElementById("messages");

        const empty = document.querySelector(".empty-chat");
        if (empty) empty.remove();

        const row = document.createElement("div");

        row.className =
            String(data.fromId) === String(currentUserId)
                ? "message-row my-message"
                : "message-row friend-message";

        let content =
            "<div class='message-bubble'>" +
            "<b>" + data.fromName + "</b>";

        if (data.text) {
            content += "<p>" + data.text + "</p>";
        }

        if (data.photos && data.photos.length > 0) {
    content += "<div class='message-gallery'>";

    data.photos.forEach(photo => {
        content += "<img src='" + photo + "' class='chat-photo'>";
    });

    content += "</div>";
}

        content +=
            "<small>" + data.date + "</small>" +
            "</div>";

                row.innerHTML = content;

        row.querySelectorAll(".chat-photo").forEach(img => {
            img.addEventListener("click", () => {
                openPhoto(img.src);
            });

            img.onload = scrollChatBottom;
        });

        messages.appendChild(row);
        scrollChatBottom();
    }

    socket.on("private message", (data) => {
        if (String(data.fromId) !== String(currentUserId)) {
    addMessage(data);
}
    });

    socket.on("online update", (onlineUsers) => {
        const status = onlineUsers[friendUsername]
            ? "🟢 Онлайн"
            : "⚫ Оффлайн";

        const mainStatus = document.getElementById("status-" + friendUsername);
        const sideStatus = document.getElementById("side-status-" + friendUsername);

        if (mainStatus) mainStatus.innerText = status;
        if (sideStatus) sideStatus.innerText = status;
    });

    const chatForm = document.getElementById("chatForm");
    const messageInput = document.getElementById("messageInput");
    messageInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
    }
});
messageInput.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
});
    const photoInput = document.getElementById("photoInput");

    const photoPreview = document.getElementById("photoPreview");

photoInput.addEventListener("change", () => {
    photoPreview.innerHTML = "";

    const photos = Array.from(photoInput.files);

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

            item.innerHTML =
                "<img src='" + e.target.result + "'>" +
                "<span>×</span>";

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

    chatForm.addEventListener("submit", async function(e) {
        e.preventDefault();

        const text = messageInput.value.trim();
        const photos = photoInput.files;

if (!text && photos.length === 0) return;

const formData = new FormData();
formData.append("message", text);

for (let i = 0; i < photos.length; i++) {
    formData.append("photos", photos[i]);
}

        messageInput.value = "";
        messageInput.style.height = "auto";
        photoInput.value = "";

        photoPreview.innerHTML = "";
photoPreview.style.display = "none";

        const response = await fetch("/send-message/" + friendId, {
            method: "POST",
            body: formData
        });

        const result = await response.json();

if (result.success && result.message) {

    addMessage(result.message);

    setTimeout(() => {

        const messages = document.getElementById("messages");
        messages.scrollTop = messages.scrollHeight;
    }, 200);

} else {
    alert("Ошибка отправки сообщения");
}
    });

    function openPhoto(src) {
        document.getElementById("modalPhoto").src = src;
        document.getElementById("photoModal").style.display = "flex";
    }

    function closePhoto() {
        document.getElementById("photoModal").style.display = "none";
    }

    window.addEventListener("load", () => {
        setTimeout(scrollChatBottom, 100);
        setTimeout(scrollChatBottom, 500);
    });

    function fixIOSChatHeight() {
    const chatPage = document.querySelector(".chat-page");

    if (!chatPage) return;

    const height = window.visualViewport
        ? window.visualViewport.height
        : window.innerHeight;

    chatPage.style.height = height + "px";

    setTimeout(() => {
        scrollChatBottom();
    }, 50);
}

if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fixIOSChatHeight);
    window.visualViewport.addEventListener("scroll", fixIOSChatHeight);
}

window.addEventListener("resize", fixIOSChatHeight);
window.addEventListener("orientationchange", fixIOSChatHeight);

fixIOSChatHeight();

</script>

    </body>
    </html>
    `);
});

app.post("/send-message/:id", messagePhotoUpload.array("photos", 10), (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({ success: false, error: "Не авторизован" });
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));
    const messages = JSON.parse(fs.readFileSync("data/messages.json"));

    const currentUser = users.find(
    u => u.id === req.session.userId
);
    const friend = users.find(u => u.id == req.params.id);

    if (!friend) {
        return res.status(404).json({ success: false, error: "Пользователь не найден" });
    }

    const newMessage = {
    from: currentUser.id,
    to: friend.id,
    text: req.body.message || "",
    photos: req.files
        ? req.files.map(file =>
            "/message-photos/" + file.filename)
        : [],
    date: new Date().toLocaleString("ru-RU")
};

    messages.push(newMessage);

    fs.writeFileSync(
        "data/messages.json",
        JSON.stringify(messages, null, 2)
    );

    const dialogId = [currentUser.id, friend.id].sort().join("-");

    const messageForClient = {
    dialogId,
    fromId: currentUser.id,
    fromName: currentUser.username,
    text: newMessage.text,
    photos: newMessage.photos,
    date: newMessage.date
};

    socketMessage = messageForClient;

    io.to(dialogId).emit("private message", messageForClient);

    res.json({
        success: true,
        message: messageForClient
    });
});

app.post("/upload-avatar", upload.single("avatar"), (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));

    const user = users.find(
    u => u.id === req.session.userId
);

    user.avatar = "/avatars/" + req.file.filename;

    fs.writeFileSync(
        "data/users.json",
        JSON.stringify(users, null, 2)
    );

    res.redirect("/profile");
});


app.get("/feed", async (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const currentUserResult = await pool.query(
    `
    SELECT id, username, login, avatar, created_at
    FROM users
    WHERE id = $1
    `,
    [req.session.userId]
);

const currentUser = currentUserResult.rows[0];

if (!currentUser) {
    req.session.destroy(() => {
        res.redirect("/login.html");
    });
    return;
}

const avatar = currentUser.avatar || "/images/logo.png";

const friendsResult = await pool.query(
    `
    SELECT u.id, u.username, u.login, u.avatar
    FROM users u
    JOIN friends f ON f.friend_id = u.id
    WHERE f.user_id = $1
    `,
    [currentUser.id]
);

const friends = friendsResult.rows;

    let onlineList = "";

    friends.forEach(friend => {
        const status = onlineUsers[friend.id] ? "🟢 Онлайн" : "⚫ Оффлайн";

        onlineList += `
            <div class="mini-user">
                <img src="${friend.avatar}" class="mini-avatar">
                <div>
                    <b>${friend.username}</b>
                    <p>${status}</p>
                </div>
            </div>
        `;
    });

    res.send(`
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <title>Lidus — Лента</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="/style.css?v=1000">
        <link rel="stylesheet"
href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    </head>

    <body>
        <div class="app-layout">

            <aside class="left-menu">
                <div class="brand-logo">
    <div class="logo-app-icon">L</div>
    <div class="logo-word">Lidus</div>
</div>

                <a href="/feed">
    <i class="fa-solid fa-house"></i>
    Лента
</a>

<a href="/profile">
    <i class="fa-solid fa-user"></i>
    Профиль
</a>

<a href="/friends">
    <i class="fa-solid fa-user-group"></i>
    Друзья
</a>

<a href="/users">
    <i class="fa-solid fa-magnifying-glass"></i>
    Найти людей
</a>

<a href="/messages">
    <i class="fa-solid fa-comments"></i>
    Сообщения
</a>

<a href="/logout">
    <i class="fa-solid fa-right-from-bracket"></i>
    Выйти
</a>

                
            </aside>

            <main class="feed">
            <div class="topbar">

    <div class="search-box">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input placeholder="Поиск в Lidus">
    </div>

    <div class="topbar-right">

        <div class="top-icon">
            <i class="fa-solid fa-bell"></i>
        </div>

        <div class="top-icon">
            <i class="fa-solid fa-envelope"></i>
        </div>

        <div class="profile-mini">
            <img src="${avatar}" class="top-avatar">
            <span>${currentUser.username}</span>
        </div>

    </div>

</div>
                <div class="mobile-app-header">
    <div class="mobile-app-title">Lidus</div>

    <div class="mobile-app-actions">
        <a href="/users">
            <i class="fa-solid fa-magnifying-glass"></i>
        </a>

        <button type="button" class="primary">
            <i class="fa-solid fa-plus"></i>
        </button>
    </div>
</div>
                <div class="feed-title">
    <h1>Добро пожаловать, ${currentUser.username} 👋</h1>
    <p>Лента новостей, друзья и активность Lidus</p>
</div>

                <div class="post-create pro-card">
    <img src="${avatar}" class="mini-avatar">

    <div class="post-input-area">
        <input placeholder="Что у вас нового?">
        <div class="post-tools">
            <button type="button"><i class="fa-regular fa-image"></i> Фото</button>
            <button type="button"><i class="fa-regular fa-face-smile"></i> Настроение</button>
            <button type="button"><i class="fa-solid fa-location-dot"></i> Место</button>
        </div>
    </div>

    <button class="publish-btn">Опубликовать</button>
</div>

                <div class="post-card">
                    <div class="post-header">
                        <img src="${avatar}" class="mini-avatar">
                        <div>
                            <b>${currentUser.username}</b>
                            <p>Сегодня</p>
                        </div>
                    </div>

                    <p>Продолжаю разработку Lidus 🚀</p>

                    <div class="post-actions">
                        <span>❤️ 12</span>
                        <span>💬 4</span>
                        <span>↗️ 1</span>
                    </div>
                </div>

                <div class="post-card">
                    <div class="post-header">
                        <img src="/images/logo.png" class="mini-avatar">
                        <div>
                            <b>Lidus</b>
                            <p>Сегодня</p>
                        </div>
                    </div>

                    <p>Новая социальная сеть выглядит всё лучше 🔥</p>

                    <div class="post-actions">
                        <span>❤️ 7</span>
                        <span>💬 2</span>
                    </div>
                </div>
            </main>

            <aside class="right-panel">
                <div class="side-card">
                    <h3>Онлайн друзья</h3>
                    ${onlineList || "<p>Нет друзей онлайн.</p>"}
                </div>

                <div class="side-card">
                    <h3>Уведомления</h3>
                    <p>🔔 Добро пожаловать в Lidus</p>
                    <p>👥 Друзья и чаты уже работают</p>
                </div>
            </aside>

        </div>
    </body>
    </html>
    `);
});

app.get("/messages", (req, res) => {

    if (!req.session.userId) {
        return res.redirect("/login.html");
    }

    const users = JSON.parse(fs.readFileSync("data/users.json"));
    const messages = JSON.parse(fs.readFileSync("data/messages.json"));

    const currentUser = users.find(
    u => u.id === req.session.userId
);

    const friends = users.filter(
        u => currentUser.friends.includes(u.id)
    );

    let list = "";

    friends.forEach(friend => {

        const dialogMessages = messages.filter(msg =>
            (msg.from === currentUser.id && msg.to === friend.id) ||
            (msg.from === friend.id && msg.to === currentUser.id)
        );

        const lastMessage = dialogMessages[dialogMessages.length - 1];

        const status = onlineUsers[friend.username]
            ? "🟢 Онлайн"
            : "⚫ Оффлайн";

        list += `
            <a class="dialog-card" href="/dialog/${friend.id}">
                <img src="${friend.avatar}" class="mini-avatar">

                <div class="dialog-info">
                    <b>${friend.username}</b>
                    <p>${lastMessage ? lastMessage.text : "Нет сообщений"}</p>
                    <small>${status}</small>
                </div>
            </a>
        `;
    });

    res.send(`
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<link rel="manifest" href="/manifest.json">

<meta name="theme-color" content="#6b4dff">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lidus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

        <title>Lidus — Сообщения</title>

        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">

        <link rel="stylesheet" href="/style.css?v=1000">

        <link rel="stylesheet"
        href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">

    </head>

    <body>

        <div class="app-layout">

            <aside class="left-menu">

                <div class="brand-logo">
                    <div class="logo-app-icon">L</div>
                    <div class="logo-word">Lidus</div>
                </div>

                <a href="/feed">
                    <i class="fa-solid fa-house"></i>
                    Лента
                </a>

                <a href="/profile">
                    <i class="fa-solid fa-user"></i>
                    Профиль
                </a>

                <a href="/friends">
                    <i class="fa-solid fa-user-group"></i>
                    Друзья
                </a>

                <a href="/users">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    Найти людей
                </a>

                <a href="/messages" class="active">
                    <i class="fa-solid fa-comments"></i>
                    Сообщения
                </a>

                <a href="/logout">
                    <i class="fa-solid fa-right-from-bracket"></i>
                    Выйти
                </a>

                

            </aside>

            <main class="feed">

                <div class="topbar">

                    <div class="search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input placeholder="Поиск по сообщениям">
                    </div>

                    <div class="topbar-right">

                        <div class="top-icon">
                            <i class="fa-solid fa-bell"></i>
                        </div>

                        <div class="top-icon">
                            <i class="fa-solid fa-envelope"></i>
                        </div>

                        <div class="profile-mini">
                            <img src="${avatar}" class="top-avatar">
                            <span>${currentUser.username}</span>
                        </div>

                    </div>

                </div>

                <div class="mobile-app-header">
    <div class="mobile-app-title">Сообщения</div>

    <div class="mobile-app-actions">
        <a href="/users">
            <i class="fa-solid fa-magnifying-glass"></i>
        </a>
    </div>
</div>

                <div class="feed-title">
                    <h1>Сообщения</h1>
                    <p>Ваши личные диалоги</p>
                </div>

                <div class="post-card">

                    ${list || `
                        <div style="text-align:center;padding:40px;">
                            <h3>Сообщений пока нет</h3>
                            <p class="muted">
                                Добавьте друзей и начните общение
                            </p>
                        </div>
                    `}

                </div>

            </main>

            <aside class="right-panel">

                <div class="side-card">
                    <h3>Статистика</h3>

                    <p>💬 Диалогов: ${friends.length}</p>

                    <p>
                        🟢 Онлайн:
                        ${
                            friends.filter(
                                friend => onlineUsers[friend.username]
                            ).length
                        }
                    </p>
                </div>

                <div class="side-card">
                    <h3>Подсказка</h3>

                    <p>💬 Выберите диалог слева</p>
                    <p>👥 Добавляйте новых друзей</p>
                    <p>🔒 Сообщения приватны</p>
                </div>

            </aside>

        </div>

    </body>
    </html>
    `);
});
io.on("connection", (socket) => {

    console.log("Socket.IO подключён");

    socket.on("join dialog", (dialogId) => {
        socket.join(dialogId);
        console.log("Вошёл в диалог:", dialogId);
    });

    socket.on("private message", (data) => {
        io.to(data.dialogId).emit("private message", data);
    });

});



const PORT = process.env.PORT || 3000;

initDb().then(() => {
    server.listen(PORT, () => {
        console.log(`Lidus запущен на порту ${PORT}`);
    });
});