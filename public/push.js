function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
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

async function enableLidusPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        alert("Этот браузер не поддерживает push-уведомления.");
        return;
    }

    if (/iPhone|iPad|iPod/i.test(navigator.userAgent) && !isStandalonePwa()) {
        alert("На iPhone сначала добавь Lidus на экран Домой, потом открой его как приложение и включи уведомления.");
        return;
    }

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
        alert("Уведомления не разрешены.");
        return;
    }

    const keyResponse = await fetch("/vapid-public-key");
    const keyData = await keyResponse.json();

    if (!keyData.publicKey) {
        alert("Push ещё не настроен на сервере. Добавь VAPID ключи в Render.");
        return;
    }

    const registration = await navigator.serviceWorker.register("/sw.js");
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        });
    }

    await fetch("/save-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription)
    });

    localStorage.setItem("lidusPushEnabled", "1");
    const btn = document.getElementById("lidusPushButton");
    if (btn) btn.remove();
}

function createPushButton() {
    if (localStorage.getItem("lidusPushEnabled") === "1") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
        enableLidusPush().catch(() => {});
        return;
    }
    if (Notification.permission === "denied") return;

    const btn = document.createElement("button");
    btn.id = "lidusPushButton";
    btn.type = "button";
    btn.innerHTML = "🔔 Включить уведомления";
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
    btn.addEventListener("click", () => enableLidusPush().catch(console.error));
    document.body.appendChild(btn);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createPushButton);
} else {
    createPushButton();
}
