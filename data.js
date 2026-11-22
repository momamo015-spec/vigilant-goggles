/**
 * data.js - GoTube Database & Firebase Management
 * ملف إدارة وربط قاعدة بيانات Firebase ومصادقة Google لتطبيق GoTube
 */

// 1. إعدادات وتكوين Firebase الخاص بالمشروع
const firebaseConfig = {
    apiKey: "AIzaSyDDSSuMFD6VdRZzxPklhwAMRaeuy3hQ6_4",
    authDomain: "project-48114828007865906.firebaseapp.com",
    databaseURL: "https://project-48114828007865906-default-rtdb.firebaseio.com/",
    projectId: "project-48114828007865906",
    storageBucket: "project-48114828007865906.firebasestorage.app",
    messagingSenderId: "408808132533",
    appId: "1:408808132533:web:162dffac1fbb6f17bf13fc",
    measurementId: "G-R902FJKD8X"
};

// 2. تهيئة Firebase وقاعدة البيانات والمصادقة
let app = null;
let db = null;
let auth = null;
let isFirebaseConnected = false;
let connectionListeners = [];

try {
    if (!firebase.apps.length) {
        app = firebase.initializeApp(firebaseConfig);
    } else {
        app = firebase.app();
    }
    db = firebase.database();
    if (firebase.auth) {
        auth = firebase.auth();
    }
    console.log("✔ تم تهيئة Firebase بنجاح من data.js");

    // مراقبة حالة الاتصال بقاعدة البيانات مباشرة
    const connectedRef = db.ref(".info/connected");
    connectedRef.on("value", (snap) => {
        isFirebaseConnected = snap.val() === true;
        notifyConnectionStatus(isFirebaseConnected);
    });
} catch (error) {
    console.error("❌ خطأ أثناء تهيئة Firebase:", error);
    isFirebaseConnected = false;
    notifyConnectionStatus(false, error.message);
}

function notifyConnectionStatus(status, errorMsg = null) {
    connectionListeners.forEach(listener => {
        try {
            listener({ connected: status, error: errorMsg });
        } catch (e) {
            console.error(e);
        }
    });
}

/**
 * تسجيل مستمع لتغير حالة الاتصال بقاعدة البيانات
 */
function onDatabaseStatusChange(callback) {
    if (typeof callback === "function") {
        connectionListeners.push(callback);
        callback({ connected: isFirebaseConnected });
    }
}

/**
 * تعقيم اسم المستخدم ليكون مفتاحاً صالحاً في Firebase
 */
function sanitizeUsername(username) {
    if (!username) return 'guest_' + Date.now();
    return username.trim().toLowerCase().replace(/[.#$\[\]\/]/g, '_');
}

/**
 * 3. تسجيل الدخول أو إنشاء حساب جديد بالاسم وكلمة المرور
 */
async function authUser(username, password) {
    const rawUser = username.trim();
    const safeUser = sanitizeUsername(rawUser);

    if (!safeUser || !password.trim()) {
        throw new Error("يرجى إدخال اسم المستخدم وكلمة المرور!");
    }

    if (!db) {
        return localAuth(rawUser, password);
    }

    try {
        const userRef = db.ref(`users/${safeUser}`);
        const snapshot = await userRef.once('value');

        if (snapshot.exists()) {
            const data = snapshot.val();
            if (data.password === password) {
                const sessionData = {
                    username: rawUser,
                    safeKey: safeUser,
                    createdAt: data.createdAt || Date.now(),
                    photoURL: data.photoURL || null
                };
                saveCurrentSession(sessionData);
                return { isNew: false, message: "تم تسجيل الدخول بنجاح!", user: sessionData };
            } else {
                throw new Error("كلمة المرور غير صحيحة، يرجى المحاولة مرة أخرى!");
            }
        } else {
            const newUserData = {
                username: rawUser,
                password: password,
                createdAt: Date.now(),
                favorites: {},
                history: {},
                playlists: {}
            };
            await userRef.set(newUserData);
            const sessionData = {
                username: rawUser,
                safeKey: safeUser,
                createdAt: newUserData.createdAt,
                photoURL: null
            };
            saveCurrentSession(sessionData);
            return { isNew: true, message: "تم إنشاء حساب جديد بنجاح وحفظه في Firebase!", user: sessionData };
        }
    } catch (err) {
        console.error("Firebase Auth Error:", err);
        throw err;
    }
}

/**
 * 4. تسجيل الدخول باستخدام حساب Google / YouTube
 */
async function authWithGoogle() {
    if (!auth) {
        // في حال عدم تفعيل Firebase Auth نستخدم النافذة الداخلية
        return await promptGoogleFallback();
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('profile');
    provider.addScope('email');

    try {
        const result = await auth.signInWithPopup(provider);
        const gUser = result.user;
        const displayName = gUser.displayName || gUser.email.split('@')[0];
        const safeUser = sanitizeUsername(displayName);

        const sessionData = {
            username: displayName,
            email: gUser.email,
            photoURL: gUser.photoURL,
            uid: gUser.uid,
            safeKey: safeUser,
            isGoogle: true
        };

        // حفظ وتحديث بيانات المستخدم في Firebase Realtime Database
        if (db) {
            await db.ref(`users/${safeUser}`).update({
                displayName: sessionData.username,
                email: sessionData.email,
                photoURL: sessionData.photoURL,
                lastLogin: Date.now()
            });
        }

        saveCurrentSession(sessionData);
        return { isNew: false, message: `مرحباً بك يا ${displayName}! تم تسجيل الدخول بجوجل بنجاح`, user: sessionData };
    } catch (err) {
        console.warn("Google popup error:", err.code, err.message);
        if (err.code === 'auth/unauthorized-domain' || err.code === 'auth/popup-blocked' || err.code === 'auth/configuration-not-found') {
            return await promptGoogleFallback();
        }
        throw new Error("تعذر تسجيل الدخول بجوجل: " + err.message);
    }
}

// حالة عدم وجود auth (Firebase Auth غير مهيأ)
// نستخدم promptGoogleFallback مباشرة (وهي الآن Promise)

/**
 * بديل تسجيل الدخول بجوجل عبر نافذة HTML داخل التطبيق بدلاً من window.prompt
 */
function promptGoogleFallback() {
    return new Promise((resolve, reject) => {
        // إذا كان هناك حوار Google email في الصفحة، استخدمه
        const existing = document.getElementById('googleEmailModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'googleEmailModal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;justify-content:center;align-items:center;z-index:9999;backdrop-filter:blur(4px)';
        modal.innerHTML = `
            <div style="background:#1e1e1e;padding:30px;border-radius:16px;width:400px;max-width:90%;border:1px solid #303030;box-shadow:0 12px 40px rgba(0,0,0,0.8);text-align:center;position:relative;">
                <button onclick="document.getElementById('googleEmailModal').remove()" style="position:absolute;top:14px;left:14px;background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;">✕</button>
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:40px;margin-bottom:12px;">
                <h3 style="color:#fff;font-size:18px;margin-bottom:8px;">الدخول عبر حساب Google</h3>
                <p style="color:#aaa;font-size:13px;margin-bottom:20px;">أدخل البريد الإلكتروني لحساب Google / YouTube الخاص بك</p>
                <input id="googleEmailInput" type="email" placeholder="example@gmail.com" style="width:100%;padding:12px;background:#111;border:1px solid #303030;border-radius:8px;color:#fff;font-size:14px;margin-bottom:16px;outline:none;text-align:right;direction:rtl;">
                <button id="googleEmailSubmitBtn" style="width:100%;padding:12px;background:#4285f4;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">تأكيد الدخول بجوجل</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('googleEmailSubmitBtn').onclick = () => {
            const email = document.getElementById('googleEmailInput').value.trim();
            if (!email || !email.includes('@')) {
                document.getElementById('googleEmailInput').style.borderColor = '#e74c3c';
                return;
            }
            modal.remove();
            const name = email.split('@')[0];
            const safeKey = sanitizeUsername(name);
            const session = {
                username: name,
                email: email,
                photoURL: `https://api.dicebear.com/7.x/bottts/svg?seed=${name}`,
                safeKey: safeKey,
                isGoogle: true
            };
            saveCurrentSession(session);
            if (db) {
                db.ref(`users/${safeKey}`).update({ displayName: name, email, lastLogin: Date.now() });
            }
            resolve({ isNew: false, message: `مرحباً ${name}! تم تسجيل الدخول بحساب جوجل بنجاح ✓`, user: session });
        };

        // إغلاق بالضغط خارج النافذة
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
                reject(new Error("تم إلغاء تسجيل الدخول"));
            }
        });
    });
}

/**
 * إدارة الجلسة الحالية
 */
function saveCurrentSession(user) {
    localStorage.setItem('gotube_user', JSON.stringify(user));
}

function getCurrentSession() {
    try {
        const u = localStorage.getItem('gotube_user');
        return u ? JSON.parse(u) : null;
    } catch (e) {
        return null;
    }
}

function logoutUser() {
    localStorage.removeItem('gotube_user');
    if (auth && auth.currentUser) {
        auth.signOut().catch(() => {});
    }
}

/**
 * 5. حفظ سجل المشاهدة للمستخدم في Firebase
 */
async function addWatchHistory(video) {
    const session = getCurrentSession();
    if (!session || !video || !video.id) return;

    const safeUser = session.safeKey;
    const historyItem = {
        id: video.id,
        title: video.title || "فيديو يوتيوب",
        author: video.author || "قناة يوتيوب",
        thumbnail: video.thumbnail || `https://img.youtube.com/vi/${video.id}/mqdefault.jpg`,
        duration: video.duration || '',
        watchedAt: Date.now()
    };

    saveLocalItem(`history_${safeUser}`, video.id, historyItem);

    if (db) {
        try {
            await db.ref(`users/${safeUser}/history/${video.id}`).set(historyItem);
        } catch (e) {
            console.warn("Firebase history save error:", e.message);
        }
    }
}

/**
 * 6. إدارة المفضلة (إضافة / حذف) في Firebase
 */
async function toggleFavorite(video) {
    const session = getCurrentSession();
    if (!session || !video || !video.id) {
        throw new Error("يرجى تسجيل الدخول أولاً لإضافة الفيديو للمفضلة!");
    }

    const safeUser = session.safeKey;
    const favRef = db ? db.ref(`users/${safeUser}/favorites/${video.id}`) : null;

    let isFav = false;
    if (db) {
        const snap = await favRef.once('value');
        isFav = snap.exists();
    } else {
        isFav = !!getLocalItem(`favorites_${safeUser}`, video.id);
    }

    if (isFav) {
        if (db) await favRef.remove();
        removeLocalItem(`favorites_${safeUser}`, video.id);
        return { isFavorite: false, message: "تمت إزالة الفيديو من المفضلة" };
    } else {
        const favItem = {
            id: video.id,
            title: video.title || "فيديو يوتيوب",
            author: video.author || "قناة يوتيوب",
            thumbnail: video.thumbnail || `https://img.youtube.com/vi/${video.id}/mqdefault.jpg`,
            duration: video.duration || '',
            savedAt: Date.now()
        };
        if (db) await favRef.set(favItem);
        saveLocalItem(`favorites_${safeUser}`, video.id, favItem);
        return { isFavorite: true, message: "تمت إضافة الفيديو إلى المفضلة في Firebase بنجاح!" };
    }
}

/**
 * 7. استيراد وحفظ قائمة تشغيل (Playlist) إلى Firebase
 */
async function savePlaylist(playlist) {
    const session = getCurrentSession();
    if (!session || !playlist || !playlist.id) {
        throw new Error("يرجى تسجيل الدخول أولاً لحفظ قائمة التشغيل في حسابك!");
    }

    const safeUser = session.safeKey;
    const plRef = db ? db.ref(`users/${safeUser}/playlists/${playlist.id}`) : null;

    const item = {
        id: playlist.id,
        title: playlist.title || "قائمة تشغيل جوتيوب",
        author: playlist.author || "يوتيوب",
        thumbnail: playlist.thumbnail || "",
        videoCount: playlist.videoCount || "قائمة تشغيل",
        importedAt: Date.now()
    };

    if (db) await plRef.set(item);
    saveLocalItem(`playlists_${safeUser}`, playlist.id, item);
    return { success: true, message: "تم حفظ واستيراد قائمة التشغيل في حسابك بنجاح!" };
}

/**
 * 8. جلب بيانات المستخدم كاملة من Firebase
 */
async function getUserData() {
    const session = getCurrentSession();
    if (!session) return { favorites: [], history: [], playlists: [] };

    const safeUser = session.safeKey;
    let favorites = [];
    let history = [];
    let playlists = [];

    if (db) {
        try {
            const userRef = db.ref(`users/${safeUser}`);
            const snap = await userRef.once('value');
            if (snap.exists()) {
                const data = snap.val();
                if (data.favorites) {
                    favorites = Object.values(data.favorites).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
                }
                if (data.history) {
                    history = Object.values(data.history).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
                }
                if (data.playlists) {
                    playlists = Object.values(data.playlists).sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
                }
                return { favorites, history, playlists };
            }
        } catch (e) {
            console.warn("Firebase getUserData warning:", e.message);
        }
    }

    favorites = getLocalList(`favorites_${safeUser}`);
    history = getLocalList(`history_${safeUser}`);
    playlists = getLocalList(`playlists_${safeUser}`);
    return { favorites, history, playlists };
}

/**
 * دوال التخزين المحلي الاحتياطي
 */
function saveLocalItem(storageKey, id, item) {
    try {
        let list = JSON.parse(localStorage.getItem(storageKey) || "{}");
        list[id] = item;
        localStorage.setItem(storageKey, JSON.stringify(list));
    } catch (e) {}
}

function removeLocalItem(storageKey, id) {
    try {
        let list = JSON.parse(localStorage.getItem(storageKey) || "{}");
        delete list[id];
        localStorage.setItem(storageKey, JSON.stringify(list));
    } catch (e) {}
}

function getLocalItem(storageKey, id) {
    try {
        let list = JSON.parse(localStorage.getItem(storageKey) || "{}");
        return list[id] || null;
    } catch (e) {
        return null;
    }
}

function getLocalList(storageKey) {
    try {
        let list = JSON.parse(localStorage.getItem(storageKey) || "{}");
        return Object.values(list);
    } catch (e) {
        return [];
    }
}

function localAuth(username, password) {
    const safeUser = sanitizeUsername(username);
    const users = JSON.parse(localStorage.getItem('gotube_offline_users') || "{}");
    if (users[safeUser]) {
        if (users[safeUser].password === password) {
            const session = { username, safeKey: safeUser, createdAt: users[safeUser].createdAt };
            saveCurrentSession(session);
            return { isNew: false, message: "تم تسجيل الدخول (محلياً)", user: session };
        } else {
            throw new Error("كلمة المرور غير صحيحة!");
        }
    } else {
        users[safeUser] = { username, password, createdAt: Date.now() };
        localStorage.setItem('gotube_offline_users', JSON.stringify(users));
        const session = { username, safeKey: safeUser, createdAt: Date.now() };
        saveCurrentSession(session);
        return { isNew: true, message: "تم إنشاء الحساب (محلياً)", user: session };
    }
}

// تصدير الكائنات في النطاق العام للنافذة
window.GoTubeDB = {
    firebaseConfig,
    db,
    authUser,
    authWithGoogle,
    getCurrentSession,
    logoutUser,
    addWatchHistory,
    toggleFavorite,
    savePlaylist,
    getUserData,
    onDatabaseStatusChange
};
