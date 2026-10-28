import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where, orderBy, limit, startAfter, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ==========================================
// 1. FIREBASE CONFIGURATION
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyB1bmPwymhioSk5RGygR7OXieq0qBAfh_8",
    authDomain: "preventive-maintenance-c3c4b.firebaseapp.com",
    projectId: "preventive-maintenance-c3c4b",
    storageBucket: "preventive-maintenance-c3c4b.firebasestorage.app",
    messagingSenderId: "896587230044",
    appId: "1:896587230044:web:abaa1969a8c689ecd8af99",
    measurementId: "G-WHFSFWWFQT"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ==========================================
// 2. STATE & UTILITIES
// ==========================================
let currentUser = null;
let state = {
    equipment: [],
    pmPlans: [],
    settings: { theme: 'light', defaultPolicy: 'schedule' }
};
let unsubscribers = [];

// Pagination tracking for History
let historyDocs = [];
let lastVisibleCursor = null;
let historyPageNum = 1;
const HISTORY_PAGE_SIZE = 50;

const DOM = (id) => document.getElementById(id);

// XSS Prevention: Safe HTML Escaping
const escapeHTML = (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
};

// CSV Anti-Injection Sanitization
const sanitizeCSV = (str) => {
    if (str === null || str === undefined) return '""';
    let s = String(str).replace(/"/g, '""');
    if (/^[=\-+\@]/.test(s)) s = "'" + s; // Block spreadsheet execution
    return `"${s}"`;
};

const showToast = (msg, type = "success") => {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    DOM("toast-container").appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

// ==========================================
// 3. SECURE DATE MATHEMATICS
// ==========================================
const getLocalTodayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

// Correct Interval Addition handling End-Of-Month clamping and Leap Years
const calculateNextDueDate = (baseDateStr, intervalStr, unit) => {
    const [y, m, d] = baseDateStr.split('-').map(Number);
    let date = new Date(y, m - 1, d);
    const interval = parseInt(intervalStr, 10);
    
    if (unit === 'Days') date.setDate(date.getDate() + interval);
    else if (unit === 'Weeks') date.setDate(date.getDate() + (interval * 7));
    else if (unit === 'Months') {
        const expectedMonth = date.getMonth() + interval;
        date.setMonth(expectedMonth);
        if (date.getMonth() !== expectedMonth % 12) date.setDate(0); 
    }
    else if (unit === 'Years') {
        const expectedMonth = date.getMonth();
        date.setFullYear(date.getFullYear() + interval);
        if (date.getMonth() !== expectedMonth) date.setDate(0); 
    }
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
};

const getStatus = (dueDateStr) => {
    const today = getLocalTodayStr();
    if (!dueDateStr) return { class: 'status-active', text: 'Active' };
    if (dueDateStr < today) return { class: 'status-overdue', text: 'Overdue' };
    if (dueDateStr === today) return { class: 'status-today', text: 'Due Today' };
    
    const diffDays = Math.ceil((new Date(dueDateStr) - new Date(today)) / (1000 * 60 * 60 * 24));
    if (diffDays <= 7) return { class: 'status-upcoming', text: 'Due Soon' };
    return { class: 'status-upcoming', text: 'Upcoming' };
};

const getEqData = (eqDocId, fallbackName) => {
    const eq = state.equipment.find(e => e.id === eqDocId);
    return { idStr: eq ? eq.eqId : 'Archived/Unknown', nameStr: eq ? eq.name : fallbackName };
};

// ==========================================
// 4. AUTH & SETTINGS
// ==========================================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        DOM("auth-view").classList.remove("active-view");
        DOM("app-view").classList.add("active-view");
        await loadSettings();
        attachRealtimeListeners();
    } else {
        currentUser = null;
        DOM("auth-view").classList.add("active-view");
        DOM("app-view").classList.remove("active-view");
        unsubscribers.forEach(unsub => unsub()); 
        unsubscribers = [];
        state.equipment = []; state.pmPlans = [];
    }
});

DOM("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = DOM("btn-login"); btn.disabled = true;
    try { await signInWithEmailAndPassword(auth, DOM("auth-email").value, DOM("auth-password").value); } 
    catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; }
});

DOM("btn-signup").addEventListener("click", async () => {
    const btn = DOM("btn-signup"); btn.disabled = true;
    try {
        await createUserWithEmailAndPassword(auth, DOM("auth-email").value, DOM("auth-password").value);
        showToast("Account provisioned successfully.");
    } catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; }
});

DOM("btn-logout").addEventListener("click", () => signOut(auth));

const loadSettings = async () => {
    try {
        const docRef = doc(db, `users/${currentUser.uid}/settings`, "preferences");
        const snap = await getDoc(docRef);
        if (snap.exists()) state.settings = { ...state.settings, ...snap.data() };
        
        DOM("user-display").textContent = state.settings.displayName || currentUser.email;
        document.documentElement.setAttribute("data-theme", state.settings.theme);
        
        DOM("set-name").value = state.settings.displayName || "";
        DOM("set-theme").value = state.settings.theme;
        DOM("set-policy").value = state.settings.defaultPolicy || "schedule";
    } catch (err) { console.error("Settings Load Error:", err); }
};

DOM("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = DOM("btn-save-settings"); btn.disabled = true;
    try {
        const data = {
            displayName: DOM("set-name").value,
            theme: DOM("set-theme").value,
            defaultPolicy: DOM("set-policy").value,
            updatedAt: serverTimestamp()
        };
        await setDoc(doc(db, `users/${currentUser.uid}/settings`, "preferences"), data, { merge: true });
        showToast("Settings updated");
        await loadSettings();
    } catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; }
});

// Routing
document.querySelectorAll(".nav-links a").forEach(link => {
    link.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelectorAll(".nav-links a").forEach(l => l.classList.remove("active"));
        document.querySelectorAll(".content-section").forEach(s => s.classList.remove("active-section"));
        link.classList.add("active");
        
        const target = link.getAttribute("data-target");
        DOM(`section-${target}`).classList.add("active-section");
        DOM("page-title").textContent = link.textContent;
        if (window.innerWidth <= 768) DOM("sidebar").classList.remove("open");
        
        if(target === 'calendar') renderCalendar();
        if(target === 'history' && historyDocs.length === 0) fetchHistoryPage(); 
    });
});
DOM("mobile-menu-open").addEventListener("click", () => DOM("sidebar").classList.add("open"));
DOM("mobile-menu-close").addEventListener("click", () => DOM("sidebar").classList.remove("open"));

// ==========================================
// 5. REALTIME SYNC (Active Entities Only)
// ==========================================
function attachRealtimeListeners() {
    const uid = currentUser.uid;
    unsubscribers.forEach(unsub => unsub());
    unsubscribers = [];

    // Equipment
    const qEq = query(collection(db, `users/${uid}/equipment`), orderBy("eqId"));
    unsubscribers.push(onSnapshot(qEq, (snap) => {
        state.equipment = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderEquipmentTable(); populateEquipmentDropdown(); updateDashboard();
    }, err => console.error("Eq Sync Error:", err)));

    // PM Plans
    const qPm = query(collection(db, `users/${uid}/pmPlans`));
    unsubscribers.push(onSnapshot(qPm, (snap) => {
        state.pmPlans = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderPMTable(); updateDashboard(); generateNotifications();
    }, err => console.error("PM Sync Error:", err)));
}

// ==========================================
// 6. DASHBOARD & NOTIFICATIONS
// ==========================================
function updateDashboard() {
    let overdue = 0, dueToday = 0, activePlans = 0;
    let actionItems = [], upcomingItems = [];
    const today = getLocalTodayStr();

    state.pmPlans.forEach(pm => {
        if (pm.status !== 'Active') return;
        activePlans++;
        if (!pm.nextDue) return;
        
        const stat = getStatus(pm.nextDue);
        if (stat.text === 'Overdue') overdue++;
        if (stat.text === 'Due Today') dueToday++;
        
        const diff = Math.ceil((new Date(pm.nextDue) - new Date(today)) / (1000 * 60 * 60 * 24));
        const item = { ...pm, statusData: stat, diff };
        
        if (diff <= 0) actionItems.push(item);
        else if (diff > 0 && diff <= 30) upcomingItems.push(item);
    });

    DOM("kpi-equipment").textContent = state.equipment.filter(e => e.status !== 'Archived').length;
    DOM("kpi-plans").textContent = activePlans;
    DOM("kpi-today").textContent = dueToday;
    DOM("kpi-overdue").textContent = overdue;

    actionItems.sort((a,b) => a.nextDue.localeCompare(b.nextDue));
    DOM("dash-action-table").querySelector("tbody").innerHTML = actionItems.map(item => {
        const eqData = getEqData(item.equipmentId, item.equipmentName);
        return `<tr><td><strong>${escapeHTML(eqData.idStr)}</strong></td><td>${escapeHTML(eqData.nameStr)}</td><td>${escapeHTML(item.taskName)}</td><td>${escapeHTML(item.nextDue)}</td><td><span class="status-badge ${item.statusData.class}">${item.statusData.text}</span></td><td><button class="btn btn-success btn-small" onclick="window.openCompleteModal('${item.id}')">Complete</button></td></tr>`;
    }).join("") || "<tr><td colspan='6'>No immediate action required.</td></tr>";

    upcomingItems.sort((a,b) => a.nextDue.localeCompare(b.nextDue));
    DOM("dash-upcoming-table").querySelector("tbody").innerHTML = upcomingItems.map(item => {
        const eqData = getEqData(item.equipmentId, item.equipmentName);
        return `<tr><td><strong>${escapeHTML(eqData.idStr)}</strong></td><td>${escapeHTML(eqData.nameStr)}</td><td>${escapeHTML(item.taskName)}</td><td>${escapeHTML(item.nextDue)}</td></tr>`;
    }).join("") || "<tr><td colspan='4'>No upcoming tasks in the next 30 days.</td></tr>";
}

function generateNotifications() {
    let notifs = [];
    const today = getLocalTodayStr();
    
    state.pmPlans.forEach(pm => {
        if(pm.status !== 'Active' || !pm.nextDue) return;
        const diff = Math.ceil((new Date(pm.nextDue) - new Date(today)) / (1000 * 60 * 60 * 24));
        const lead = 7; 
        
        if(diff <= lead) {
            const eqData = getEqData(pm.equipmentId, pm.equipmentName);
            const msg = diff < 0 ? `OVERDUE: ${eqData.idStr} - ${pm.taskName}` : 
                        diff === 0 ? `DUE TODAY: ${eqData.idStr} - ${pm.taskName}` : 
                        `DUE SOON (${diff}d): ${eqData.idStr} - ${pm.taskName}`;
            notifs.push({ id: pm.id, msg: msg, diff: diff });
        }
    });

    notifs.sort((a,b) => a.diff - b.diff);
    DOM("notification-count").textContent = notifs.length;
    DOM("notification-count").classList.toggle("hidden", notifs.length === 0);
    DOM("notification-list").innerHTML = notifs.map(n => `<li onclick="window.openCompleteModal('${n.id}')">${escapeHTML(n.msg)}</li>`).join("") || "<li class='text-muted' style='text-align:center; padding:1rem;'>All caught up!</li>";
}
DOM("btn-notifications").addEventListener("click", () => DOM("notification-dropdown").classList.toggle("hidden"));

// ==========================================
// 7. EQUIPMENT CRUD
// ==========================================
function renderEquipmentTable() {
    const term = DOM("search-equipment").value.toLowerCase();
    const statusFilter = DOM("filter-eq-status").value;
    
    DOM("equipment-table").querySelector("tbody").innerHTML = state.equipment
        .filter(eq => (statusFilter === 'All' || eq.status === statusFilter) &&
                      (eq.name.toLowerCase().includes(term) || eq.eqId.toLowerCase().includes(term)))
        .map((eq, index) => `<tr>
            <td>${index + 1}</td>
            <td><strong>${escapeHTML(eq.eqId)}</strong></td>
            <td>${escapeHTML(eq.name)}</td>
            <td>${escapeHTML(eq.category)}</td>
            <td>${escapeHTML(eq.location || '-')}</td>
            <td><span class="status-badge ${eq.status === 'Active' ? 'status-active' : 'status-archived'}">${eq.status}</span></td>
            <td>
                <button class="btn-icon" onclick="window.editEq('${eq.id}')">✏️</button>
                <button class="btn-icon" style="color: var(--danger);" onclick="window.deleteEq('${eq.id}')">🗑️</button>
            </td>
        </tr>`).join("");
}
DOM("search-equipment").addEventListener("input", renderEquipmentTable);
DOM("filter-eq-status").addEventListener("change", renderEquipmentTable);

function populateEquipmentDropdown() {
    DOM("eq-list-active").innerHTML = state.equipment
        .filter(e => e.status === 'Active')
        .map(e => `<option value="${escapeHTML(e.eqId)} - ${escapeHTML(e.name)}">`)
        .join("");
}

DOM("btn-add-equipment").addEventListener("click", () => {
    DOM("form-equipment").reset();
    DOM("eq-doc-id").value = "";
    DOM("eq-status").value = "Active";
    DOM("modal-equip-title").textContent = "Add Equipment";
    DOM("modal-equipment").classList.remove("hidden");
    DOM("modal-backdrop").classList.remove("hidden");
});

DOM("form-equipment").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = DOM("btn-save-eq"); btn.disabled = true;
    const docId = DOM("eq-doc-id").value;
    const eqIdVal = DOM("eq-id").value.trim();

    if(state.equipment.some(eq => eq.eqId.toLowerCase() === eqIdVal.toLowerCase() && eq.id !== docId)) {
        showToast("Equipment ID already exists.", "error");
        btn.disabled = false;
        return;
    }

    const data = {
        eqId: eqIdVal, name: DOM("eq-name").value.trim(), category: DOM("eq-category").value,
        serial: DOM("eq-serial").value.trim(), brand: DOM("eq-brand").value.trim(), 
        model: DOM("eq-model").value.trim(), location: DOM("eq-location").value.trim(),
        status: DOM("eq-status").value, notes: DOM("eq-notes").value.trim(), updatedAt: serverTimestamp()
    };
    
    try {
        if(docId) await updateDoc(doc(db, `users/${currentUser.uid}/equipment`, docId), data);
        else { data.createdAt = serverTimestamp(); await addDoc(collection(db, `users/${currentUser.uid}/equipment`), data); }
        window.closeModals(); showToast("Equipment saved successfully");
    } catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; }
});

window.editEq = (id) => { 
    const eq = state.equipment.find(e => e.id === id);
    if(!eq) return;
    DOM("eq-doc-id").value = eq.id; DOM("eq-id").value = eq.eqId; DOM("eq-name").value = eq.name;
    DOM("eq-category").value = eq.category; DOM("eq-serial").value = eq.serial || "";
    DOM("eq-brand").value = eq.brand || ""; DOM("eq-model").value = eq.model || ""; 
    DOM("eq-location").value = eq.location || ""; DOM("eq-status").value = eq.status || "Active"; 
    DOM("eq-notes").value = eq.notes || "";
    DOM("modal-equip-title").textContent = "Edit Equipment";
    DOM("modal-equipment").classList.remove("hidden"); DOM("modal-backdrop").classList.remove("hidden");
};

// ==========================================
// 8. PM PLANS CRUD
// ==========================================
function renderPMTable() {
    const term = DOM("search-pm").value.toLowerCase();
    const statusFilter = DOM("filter-pm-status").value;
    
    DOM("pm-table").querySelector("tbody").innerHTML = state.pmPlans
        .filter(pm => {
            const eqData = getEqData(pm.equipmentId, pm.equipmentName);
            const textMatch = pm.taskName.toLowerCase().includes(term) || eqData.idStr.toLowerCase().includes(term) || eqData.nameStr.toLowerCase().includes(term);
            const statMatch = statusFilter === 'All' || pm.status === statusFilter;
            return textMatch && statMatch;
        })
        .map(pm => {
            const stat = getStatus(pm.nextDue);
            const eqData = getEqData(pm.equipmentId, pm.equipmentName);
            return `<tr>
                <td><strong>${escapeHTML(eqData.idStr)}</strong></td>
                <td>${escapeHTML(eqData.nameStr)}</td>
                <td>${escapeHTML(pm.taskName)}</td>
                <td>Every ${pm.interval} ${pm.unit}</td>
                <td>${pm.status === 'Active' ? escapeHTML(pm.nextDue) : '-'}</td>
                <td><span class="status-badge ${pm.status === 'Active' ? stat.class : 'status-archived'}">${pm.status === 'Active' ? stat.text : 'Archived'}</span></td>
                <td>
                    ${pm.status === 'Active' ? `<button class="btn btn-success btn-small" onclick="window.openCompleteModal('${pm.id}')">✓</button>` : ''}
                    <button class="btn-icon" onclick="window.editPm('${pm.id}')">✏️</button>
                    <button class="btn-icon" style="color: var(--danger);" onclick="window.deletePm('${pm.id}')">🗑️</button>
                </td>
            </tr>`;
        }).join("");
}
DOM("search-pm").addEventListener("input", renderPMTable);
DOM("filter-pm-status").addEventListener("change", renderPMTable);

DOM("btn-add-pm").addEventListener("click", () => {
    DOM("form-pm").reset();
    DOM("pm-doc-id").value = "";
    DOM("modal-pm-title").textContent = "Add PM Plan";
    DOM("pm-next-due").value = getLocalTodayStr(); 
    DOM("pm-status").value = "Active";
    DOM("modal-pm").classList.remove("hidden");
    DOM("modal-backdrop").classList.remove("hidden");
});

DOM("form-pm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const searchVal = DOM("pm-equipment-search").value;
    const eq = state.equipment.find(e => `${e.eqId} - ${e.name}` === searchVal);
    if(!eq) return showToast("Select valid equipment from dropdown.", "error");

    const btn = DOM("btn-save-pm"); btn.disabled = true;
    const docId = DOM("pm-doc-id").value;
    const checklist = DOM("pm-checklist").value.split('\n').map(s=>s.trim()).filter(Boolean);

    const data = {
        equipmentId: eq.id, equipmentName: eq.name, taskName: DOM("pm-task-name").value.trim(), 
        interval: parseInt(DOM("pm-interval").value, 10), unit: DOM("pm-unit").value, 
        nextDue: DOM("pm-next-due").value, checklist: checklist, 
        status: DOM("pm-status").value, updatedAt: serverTimestamp()
    };

    try {
        if(docId) await updateDoc(doc(db, `users/${currentUser.uid}/pmPlans`, docId), data);
        else { data.createdAt = serverTimestamp(); await addDoc(collection(db, `users/${currentUser.uid}/pmPlans`), data); }
        window.closeModals(); showToast("PM Plan saved");
    } catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; }
});

window.editPm = (id) => {
    const pm = state.pmPlans.find(p => p.id === id);
    if(!pm) return;
    DOM("pm-doc-id").value = pm.id;
    const eqData = getEqData(pm.equipmentId, pm.equipmentName);
    DOM("pm-equipment-search").value = `${eqData.idStr} - ${eqData.nameStr}`;
    DOM("pm-task-name").value = pm.taskName; DOM("pm-interval").value = pm.interval;
    DOM("pm-unit").value = pm.unit; DOM("pm-next-due").value = pm.nextDue || getLocalTodayStr();
    DOM("pm-status").value = pm.status || 'Active';
    DOM("pm-checklist").value = (pm.checklist || []).join('\n');
    DOM("modal-pm-title").textContent = "Edit PM Plan";
    DOM("modal-pm").classList.remove("hidden"); DOM("modal-backdrop").classList.remove("hidden");
};

// ==========================================
// 9. HISTORY PAGINATION & EXPORT 
// ==========================================
const fetchHistoryPage = async (direction = 'initial') => {
    const btnNext = DOM("btn-hist-next"); const btnPrev = DOM("btn-hist-prev");
    btnNext.disabled = true; btnPrev.disabled = true;
    
    try {
        let q = query(collection(db, `users/${currentUser.uid}/maintenanceHistory`), orderBy("completionDate", "desc"));
        
        const fromDate = DOM("filter-from-date").value;
        const toDate = DOM("filter-to-date").value;
        if (fromDate) q = query(q, where("completionDate", ">=", fromDate));
        if (toDate) q = query(q, where("completionDate", "<=", toDate));
        
        q = query(q, limit(HISTORY_PAGE_SIZE));

        if (direction === 'next' && lastVisibleCursor) {
            q = query(q, startAfter(lastVisibleCursor));
        } else if (direction === 'initial') {
            historyPageNum = 1;
        } 
        
        const snap = await getDocs(q);
        if(!snap.empty) {
            lastVisibleCursor = snap.docs[snap.docs.length - 1];
            historyDocs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderHistoryTable();
            DOM("hist-page-info").textContent = `Page ${historyPageNum}`;
            if(snap.docs.length === HISTORY_PAGE_SIZE) btnNext.disabled = false;
            if(historyPageNum > 1) btnPrev.disabled = false;
        } else {
            if(direction === 'initial') { historyDocs = []; renderHistoryTable(); }
            else showToast("No more records.", "warning");
        }
    } catch (err) { showToast(err.message, "error"); }
};

DOM("btn-load-history").addEventListener("click", () => fetchHistoryPage('initial'));
DOM("btn-hist-next").addEventListener("click", () => { historyPageNum++; fetchHistoryPage('next'); });
DOM("btn-hist-prev").addEventListener("click", () => { historyPageNum = 1; fetchHistoryPage('initial'); }); 

function renderHistoryTable() {
    const term = DOM("search-history").value.toLowerCase();
    const filtered = historyDocs.filter(h => {
        const taskText = (h.taskSnapshotName || h.taskName || "").toLowerCase();
        const eqIdText = (h.equipmentSnapshotId || h.equipmentId || "").toLowerCase();
        return taskText.includes(term) || eqIdText.includes(term);
    });

    DOM("history-table").querySelector("tbody").innerHTML = filtered.map(h => {
        return `<tr>
            <td>${escapeHTML(h.completionDate)}</td>
            <td><strong>${escapeHTML(h.equipmentSnapshotId || h.equipmentId)}</strong></td>
            <td>${escapeHTML(h.equipmentSnapshotName || h.equipmentName)}</td>
            <td>${escapeHTML(h.taskSnapshotName || h.taskName)}</td>
            <td>${escapeHTML(h.recordedBy)}</td>
            <td><button class="btn-icon" style="color: var(--danger);" onclick="window.deleteHistory('${h.id}')">🗑️</button></td>
        </tr>`;
    }).join("") || "<tr><td colspan='6' class='text-center'>No records found</td></tr>";
}
DOM("search-history").addEventListener("input", renderHistoryTable);

DOM("btn-export-csv").addEventListener("click", async () => {
    const btn = DOM("btn-export-csv"); btn.disabled = true; btn.textContent = "Exporting...";
    try {
        let q = query(collection(db, `users/${currentUser.uid}/maintenanceHistory`), orderBy("completionDate", "desc"));
        if (DOM("filter-from-date").value) q = query(q, where("completionDate", ">=", DOM("filter-from-date").value));
        if (DOM("filter-to-date").value) q = query(q, where("completionDate", "<=", DOM("filter-to-date").value));
        
        const snap = await getDocs(q);
        if(snap.empty) return showToast("No records match export criteria", "warning");

        const headers = ["Completion Date", "Equipment ID", "Equipment Name", "Task", "Scheduled Due", "Work Performed", "Issues Found", "Recorded By"];
        const rows = snap.docs.map(doc => {
            const h = doc.data();
            return [
                sanitizeCSV(h.completionDate), sanitizeCSV(h.equipmentSnapshotId || h.equipmentId), 
                sanitizeCSV(h.equipmentSnapshotName || h.equipmentName), sanitizeCSV(h.taskSnapshotName || h.taskName), 
                sanitizeCSV(h.scheduledDue), sanitizeCSV(h.workPerformed), sanitizeCSV(h.issuesFound), sanitizeCSV(h.recordedBy)
            ];
        });
        
        const csvContent = "data:text/csv;charset=utf-8,\uFEFF" + [headers.join(",")].concat(rows.map(e => e.join(","))).join("\n");
        const link = document.createElement("a");
        link.href = encodeURI(csvContent);
        link.download = `PM_History_Export_${getLocalTodayStr()}.csv`;
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
    } catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; btn.textContent = "Export CSV"; }
});

// ==========================================
// 10. MAINTENANCE COMPLETION LOGIC
// ==========================================
window.openCompleteModal = (pmId) => {
    const pm = state.pmPlans.find(p => p.id === pmId);
    if(!pm) return;
    DOM("form-complete-pm").reset();
    DOM("comp-pm-id").value = pm.id;
    DOM("comp-next-due-basis").value = state.settings.defaultPolicy;
    
    const eqData = getEqData(pm.equipmentId, pm.equipmentName);
    DOM("comp-task-display").textContent = `${eqData.idStr} - ${eqData.nameStr} - ${pm.taskName} (Due: ${pm.nextDue})`;
    DOM("comp-date").value = getLocalTodayStr();
    
    const clContainer = DOM("comp-checklist-container");
    if(pm.checklist && pm.checklist.length > 0) {
        clContainer.innerHTML = pm.checklist.map((item, i) => `
            <div class="checklist-item">
                <span>${escapeHTML(item)}</span>
                <select class="cl-select" data-name="${escapeHTML(item)}" required>
                    <option value="" disabled selected>Select...</option>
                    <option value="OK">OK</option>
                    <option value="Not OK">Not OK</option>
                    <option value="N/A">N/A</option>
                </select>
            </div>`).join("");
    } else { clContainer.innerHTML = "<p class='text-muted text-small'>No checklist defined.</p>"; }
    
    DOM("modal-complete-pm").classList.remove("hidden"); DOM("modal-backdrop").classList.remove("hidden");
};

DOM("form-complete-pm").addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const checklistResults = [];
    const selects = DOM("comp-checklist-container").querySelectorAll(".cl-select");
    for (let sel of selects) {
        if (!sel.value) return showToast("Please answer all checklist items.", "error");
        checklistResults.push({ item: sel.getAttribute('data-name'), status: sel.value });
    }

    const btn = DOM("btn-save-completion"); btn.disabled = true;
    const pmId = DOM("comp-pm-id").value;
    const pm = state.pmPlans.find(p => p.id === pmId);
    const eqData = getEqData(pm.equipmentId, pm.equipmentName);
    
    const compDateStr = DOM("comp-date").value;
    const policy = DOM("comp-next-due-basis").value;
    let baseDate = policy === 'completion' ? compDateStr : pm.nextDue;
    
    let nextDue = calculateNextDueDate(baseDate, pm.interval, pm.unit);
    if (policy === 'schedule') {
        const today = getLocalTodayStr();
        while (nextDue <= today && nextDue <= compDateStr) {
            nextDue = calculateNextDueDate(nextDue, pm.interval, pm.unit);
        }
    }

    const batch = writeBatch(db);
    batch.set(doc(collection(db, `users/${currentUser.uid}/maintenanceHistory`)), {
        equipmentId: pm.equipmentId, equipmentSnapshotId: eqData.idStr, equipmentSnapshotName: eqData.nameStr,
        pmPlanId: pm.id, taskSnapshotName: pm.taskName, scheduledDue: pm.nextDue, completionDate: compDateStr, 
        schedulingPolicyUsed: policy, workPerformed: DOM("comp-work").value, issuesFound: DOM("comp-issues").value, 
        checklistResults: checklistResults, recordedBy: currentUser.email, timestamp: serverTimestamp()
    });
    
    batch.update(doc(db, `users/${currentUser.uid}/pmPlans`, pmId), { nextDue: nextDue, lastCompleted: compDateStr });

    try { await batch.commit(); window.closeModals(); showToast("Maintenance recorded successfully."); } 
    catch (err) { showToast(err.message, "error"); } finally { btn.disabled = false; }
});

// ==========================================
// 11. CALENDAR VIEW
// ==========================================
let currentCalDate = new Date();

function renderCalendar() {
    const grid = DOM("calendar-grid");
    grid.innerHTML = "";
    
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
        const d = document.createElement("div"); d.className = "cal-day-name"; d.textContent = day; grid.appendChild(d);
    });

    const year = currentCalDate.getFullYear();
    const month = currentCalDate.getMonth();
    DOM("calendar-month-year").textContent = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(currentCalDate);

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = getLocalTodayStr();

    const tasksByDate = {};
    state.pmPlans.forEach(pm => {
        if(pm.status === 'Active' && pm.nextDue) {
            if(pm.nextDue.startsWith(`${year}-${String(month+1).padStart(2,'0')}`)) {
                if(!tasksByDate[pm.nextDue]) tasksByDate[pm.nextDue] = [];
                tasksByDate[pm.nextDue].push(pm);
            }
        }
    });

    let html = "";
    for(let i = 0; i < firstDay; i++) { html += `<div class="cal-day other-month"></div>`; }
    
    for(let i = 1; i <= daysInMonth; i++) {
        let dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(i).padStart(2,'0')}`;
        let isToday = dateStr === todayStr ? "today" : "";
        let tasks = tasksByDate[dateStr] || [];
        
        let dots = tasks.map(t => {
            let stat = getStatus(t.nextDue);
            let cls = stat.text === 'Overdue' ? 'dot-overdue' : stat.text === 'Due Today' ? 'dot-today' : 'dot-upcoming';
            return `<span class="cal-dot ${cls}"></span>`;
        }).join("");

        html += `<div class="cal-day ${isToday}" onclick="window.viewDayDetails('${dateStr}')"><span class="day-num">${i}</span><br><div class="dots">${dots}</div></div>`;
    }
    grid.innerHTML += html;
}

DOM("btn-cal-prev").addEventListener("click", () => { currentCalDate.setMonth(currentCalDate.getMonth() - 1); renderCalendar(); });
DOM("btn-cal-next").addEventListener("click", () => { currentCalDate.setMonth(currentCalDate.getMonth() + 1); renderCalendar(); });

window.viewDayDetails = (dateStr) => {
    const tasks = state.pmPlans.filter(pm => pm.status === 'Active' && pm.nextDue === dateStr);
    DOM("calendar-day-details").classList.remove("hidden");
    DOM("cal-detail-title").textContent = `Scheduled Tasks: ${dateStr}`;
    
    DOM("cal-detail-list").innerHTML = tasks.length === 0 ? "<p class='text-muted'>No tasks scheduled.</p>" : tasks.map(t => {
        const eqData = getEqData(t.equipmentId, t.equipmentName);
        return `<li style="margin-bottom:0.5rem; padding:0.5rem; border:1px solid var(--border); border-radius:4px; display:flex; justify-content:space-between; align-items:center;">
            <div><strong>${escapeHTML(eqData.idStr)}</strong> - ${escapeHTML(eqData.nameStr)}<br>${escapeHTML(t.taskName)}</div>
            <button class="btn btn-success btn-small" onclick="window.openCompleteModal('${t.id}')">Complete</button>
        </li>`;
    }).join("");
};

// ==========================================
// 12. MODAL CONTROLS
// ==========================================
window.closeModals = () => {
    document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
    DOM("modal-backdrop").classList.add("hidden");
};

document.addEventListener("click", (e) => {
    if (e.target.closest(".btn-close-modal") || e.target.id === "modal-backdrop") {
        e.preventDefault();
        window.closeModals();
    }
});

// ==========================================
// 13. DELETE OPERATIONS
// ==========================================
window.deleteEq = async (id) => {
    if(!confirm("Are you sure you want to delete this equipment?")) return;
    try {
        await deleteDoc(doc(db, `users/${currentUser.uid}/equipment`, id));
        showToast("Equipment deleted successfully");
    } catch (err) { showToast(err.message, "error"); }
};

window.deletePm = async (id) => {
    if(!confirm("Are you sure you want to delete this PM Plan?")) return;
    try {
        await deleteDoc(doc(db, `users/${currentUser.uid}/pmPlans`, id));
        showToast("PM Plan deleted successfully");
    } catch (err) { showToast(err.message, "error"); }
};

window.deleteHistory = async (id) => {
    if(!confirm("Are you sure you want to delete this history record?")) return;
    try {
        await deleteDoc(doc(db, `users/${currentUser.uid}/maintenanceHistory`, id));
        showToast("History record deleted");
        fetchHistoryPage('initial');
    } catch (err) { showToast(err.message, "error"); }
};

// ==========================================
// 14. EXCEL IMPORT (Equipment - With Duplicate Check)
// ==========================================
DOM("btn-import-excel").addEventListener("click", () => {
    DOM("import-excel-file").click();
});

DOM("import-excel-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);

            if (jsonData.length === 0) {
                return showToast("The Excel file is empty.", "error");
            }

            const batch = writeBatch(db);
            let addedCount = 0;
            let updatedCount = 0;

            jsonData.forEach((row) => {
                const rawEqId = row.eqId || row.ID || row.id || row.EquipmentID || row["Equipment ID"];
                const rawName = row.name || row.Name || row.EquipmentName || row["Equipment Name"];
                const rawCategory = row.category || row.Category || "Other";

                if (rawEqId && rawName) {
                    const eqIdStr = String(rawEqId).trim();
                    
                    // Check if machine ID already exists in current state
                    const existingEq = state.equipment.find(eq => eq.eqId.toLowerCase() === eqIdStr.toLowerCase());
                    
                    const equipmentData = {
                        eqId: eqIdStr,
                        name: String(rawName).trim(),
                        category: String(rawCategory).trim(),
                        serial: String(row.serial || row.Serial || "").trim(),
                        brand: String(row.brand || row.Brand || "").trim(),
                        model: String(row.model || row.Model || "").trim(),
                        location: String(row.location || row.Location || "").trim(),
                        status: "Active",
                        updatedAt: serverTimestamp()
                    };

                    if (existingEq) {
                        // ID exists -> Update the existing document
                        const docRef = doc(db, `users/${currentUser.uid}/equipment`, existingEq.id);
                        batch.update(docRef, equipmentData);
                        updatedCount++;
                    } else {
                        // ID doesn't exist -> Create a new document
                        equipmentData.notes = "Imported from Excel";
                        equipmentData.createdAt = serverTimestamp();
                        const newDocRef = doc(collection(db, `users/${currentUser.uid}/equipment`));
                        batch.set(newDocRef, equipmentData);
                        addedCount++;
                    }
                }
            });

            if (addedCount > 0 || updatedCount > 0) {
                await batch.commit();
                showToast(`${addedCount} new added, ${updatedCount} updated successfully!`);
            } else {
                showToast("No valid data found. Check your column headers.", "warning");
            }
        } catch (err) {
            showToast("Error reading file: " + err.message, "error");
        } finally {
            DOM("import-excel-file").value = ""; 
        }
    };
    reader.readAsArrayBuffer(file);
});
