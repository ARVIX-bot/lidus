function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
}

function isStandalonePwa() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function showPushButton(text = "🔔 Включить уведомления") {
    if (document.getElementById("lidusPushButton")) return;

    const btn = document.createElement("button");
    btn.id = "lidusPushButton";
    btn.type = "button";
    btn.innerHTML = text;
    btn.style.position = "fixed";
    btn.style.left = "50%";
    btn.style.bottom = "86px";
    btn.style.transform = "translateX(-50%)";
    btn.style.zIndex = "999999";
    btn.style.border = "0";
    btn.style.borderRadius = "999px";
    btn.style.padding = "10px 16px";
    btn.style.background = "linear-gradient(135deg,#6b4dff,#9a6cff)";
    btn.style.color = "white";
    btn.style.fontWeight = "800";
    btn.style.boxShadow = "0 10px 30px rgba(0,0,0,.35)";
    btn.addEventListener("click", () => enableLidusPush().catch((error) => {
        console.error("Ошибка включения push:", error);
        alert("Не удалось включить уведомления. Открой консоль или попробуй очистить данные сайта.");
    }));

    document.body.appendChild(btn);
}

function hidePushButton() {
    const btn = document.getElementById("lidusPushButton");
    if (btn) btn.remove();
}

async function getPushSubscription() {
    if (!("serviceWorker" in navigator)) return null;

    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
}

async function enableLidusPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        alert("Этот браузер не поддерживает push-уведомления.");
        return false;
    }

    if (isIOS() && !isStandalonePwa()) {
        alert("На iPhone сначала добавь Lidus на экран Домой, потом открой его как приложение и включи уведомления.");
        return false;
    }

    const registration = await navigator.serviceWorker.register("/sw.js");

    let permission = Notification.permission;

    if (permission === "default") {
        permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
        localStorage.removeItem("lidusPushEnabled");
        showPushButton("🔔 Разрешить уведомления");
        alert("Уведомления не разрешены.");
        return false;
    }

    const keyResponse = await fetch("/vapid-public-key", {
        credentials: "same-origin"
    });

    if (!keyResponse.ok) {
        throw new Error("Не удалось получить VAPID ключ: " + keyResponse.status);
    }

    const keyData = await keyResponse.json();

    if (!keyData.publicKey) {
        alert("Push ещё не настроен на сервере. Добавь VAPID ключи в Render.");
        return false;
    }

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        });
    }

    const saveResponse = await fetch("/save-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(subscription)
    });

    if (!saveResponse.ok) {
        const text = await saveResponse.text();
        throw new Error("Не удалось сохранить push-подписку: " + saveResponse.status + " " + text);
    }

    localStorage.setItem("lidusPushEnabled", "1");
    hidePushButton();

    console.log("Lidus push enabled:", subscription.endpoint);
    return true;
}

async function createPushButton() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

    if (isIOS() && !isStandalonePwa()) {
        return;
    }

    try {
        await navigator.serviceWorker.register("/sw.js");

        if (Notification.permission === "denied") {
            localStorage.removeItem("lidusPushEnabled");
            return;
        }

        const subscription = await getPushSubscription();

        if (!subscription) {
            localStorage.removeItem("lidusPushEnabled");
            showPushButton("🔔 Включить уведомления");
            return;
        }

        const saveResponse = await fetch("/save-subscription", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(subscription)
        });

        if (saveResponse.ok) {
            localStorage.setItem("lidusPushEnabled", "1");
            hidePushButton();
        } else {
            localStorage.removeItem("lidusPushEnabled");
            showPushButton("🔔 Обновить уведомления");
        }
    } catch (error) {
        console.error("Ошибка проверки push:", error);
        localStorage.removeItem("lidusPushEnabled");
        showPushButton("🔔 Включить уведомления");
    }
}

window.enableLidusPush = enableLidusPush;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createPushButton);
} else {
    createPushButton();
}
