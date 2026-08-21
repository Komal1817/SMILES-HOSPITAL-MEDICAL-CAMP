const GOOGLE_SCRIPT_URL ="https://script.google.com/macros/s/AKfycbyEViQDbOFTdA9UIJLPFoNxf0WdX1NIjllmYqwQAGPp8HEGZisiuXq1oSvsF43PwG0DTQ/exec"


/* =========================================================
   CENTRAL MULTI-DEVICE STATE
   Google Apps Script + Sheets are the source of truth.
   localStorage is only a fast offline cache.
========================================================= */

let adminToken = sessionStorage.getItem("smilesAdminToken") || "";
let sharedStateVersion = "";
let patientsStateVersion = "";
let sharedStateInitialized = false;
let sharedStateSyncTimer = null;
let sharedStateDirty = false;
let sharedStateSyncInFlight = false;

async function callGoogleScript(action, extra = {}) {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...extra })
    });

    const result = await response.json();
    if (!result.ok) {
        throw new Error(result.error || `Google Apps Script action failed: ${action}`);
    }
    return result;
}

async function loginAdminOnServer(username, password) {
    const result = await callGoogleScript("loginAdmin", { username, password });
    adminToken = result.token || "";
    if (!adminToken) throw new Error("Admin session token was not returned.");
    sessionStorage.setItem("smilesAdminToken", adminToken);
    isAdmin = true;
    return result;
}

function clearAdminSession() {
    adminToken = "";
    isAdmin = false;
    sessionStorage.removeItem("smilesAdminToken");
}

async function loadSharedState(strict = false) {
    try {
        const result = await callGoogleScript("getState");
        const state = result.state || {};

        sharedStateInitialized = state.initialized !== false;
        if (state.initialized === false) {
            /* First deployment: keep the current device's existing setup as a migration source. */
            return state;
        }

        if (state.version && state.version === sharedStateVersion) {
            return state;
        }

        camps = Array.isArray(state.camps) ? state.camps : [];
        doctors = Array.isArray(state.doctors) ? state.doctors : [];
        config = {
            ...DEFAULT_CONFIG,
            ...(state.config || {}),
            margins: {
                ...DEFAULT_CONFIG.margins,
                ...((state.config || {}).margins || {})
            },
            letterheadProfiles: {
                ...((state.config || {}).letterheadProfiles || {})
            }
        };

        sharedStateVersion = String(state.version || "");
        patientsStateVersion = String(state.patientsVersion || patientsStateVersion || "");
        sharedStateDirty = false;

        persistAll();
        renderAdminLists();
        updateApplication();
        updatePrintStyles();
        loadLetterheadSettingsToAdmin();
        updateLetterheadMarginPreview();
        renderPatients();

        const name = document.getElementById("letterheadFileName");
        if (name) name.textContent = config.letterheadFileName || "Letterhead";

        return state;
    } catch (error) {
        console.warn("Shared state load failed:", error);
        if (strict) throw error;
        return null;
    }
}

async function saveSharedState(options = {}) {
    if (!isAdmin || !adminToken) {
        throw new Error("Admin access is required to save shared configuration.");
    }

    const result = await callGoogleScript("saveState", {
        token: adminToken,
        camps,
        doctors,
        config: {
            ...config,
            /* Do not send a huge cached data URL when the current letterhead
               is already stored centrally. The server preserves its file. */
            letterhead: options.letterheadData || "",
            deleteLetterhead: Boolean(options.deleteLetterhead),
            activeCampId: config.activeCampId || "",
            margins: config.margins || DEFAULT_CONFIG.margins,
            letterheadProfiles: config.letterheadProfiles || {}
        }
    });

    if (result.state) {
        sharedStateVersion = String(result.state.version || "");
        patientsStateVersion = String(result.state.patientsVersion || patientsStateVersion || "");
        camps = result.state.camps || camps;
        doctors = result.state.doctors || doctors;
        config = {
            ...DEFAULT_CONFIG,
            ...(result.state.config || config),
            margins: {
                ...DEFAULT_CONFIG.margins,
                ...((result.state.config || config).margins || {})
            },
            letterheadProfiles: {
                ...((result.state.config || config).letterheadProfiles || {})
            }
        };
    }

    sharedStateDirty = false;
    persistAll();
    renderAdminLists();
    updateApplication();
    updatePrintStyles();
    loadLetterheadSettingsToAdmin();
    updateLetterheadMarginPreview();
    return result;
}

async function bootstrapSharedStateFromLocal() {
    if (!isAdmin || !adminToken || sharedStateInitialized) return;
    try {
        const result = await callGoogleScript("saveState", {
            token: adminToken,
            camps,
            doctors,
            config: {
                ...config,
                letterhead: (config.letterhead || "").startsWith("data:image/") ? config.letterhead : "",
                margins: config.margins || DEFAULT_CONFIG.margins,
                letterheadProfiles: config.letterheadProfiles || {}
            }
        });
        sharedStateInitialized = true;
        sharedStateVersion = String(result.state?.version || "");
        patientsStateVersion = String(result.state?.patientsVersion || patientsStateVersion || "");
        if (result.state) {
            camps = result.state.camps || camps;
            doctors = result.state.doctors || doctors;
            config = {
                ...DEFAULT_CONFIG,
                ...(result.state.config || config),
                margins: { ...DEFAULT_CONFIG.margins, ...((result.state.config || config).margins || {}) },
                letterheadProfiles: { ...((result.state.config || config).letterheadProfiles || {}) }
            };
        }
        persistAll(); renderAdminLists(); updateApplication(); updatePrintStyles();
        loadLetterheadSettingsToAdmin(); updateLetterheadMarginPreview();
        showStatus("adminStatus", "Existing setup migrated to central storage. All tablets can now share it.", "success");
    } catch (error) {
        alert("Unable to initialize central configuration.\n\n" + error.message);
    }
}

async function syncSharedState() {
    if (sharedStateSyncInFlight || sharedStateDirty) return;
    sharedStateSyncInFlight = true;
    try {
        const result = await callGoogleScript("getState");
        const state = result.state || {};
        const version = String(state.version || "");
        const patientVersion = String(state.patientsVersion || "");

        if (version && version !== sharedStateVersion) {
            await loadSharedState(false);
        }

        if (patientVersion && patientVersion !== patientsStateVersion) {
            await loadPatientsFromGoogleSheets(false);
        }
    } catch (error) {
        console.warn("Background shared-state sync failed:", error);
    } finally {
        sharedStateSyncInFlight = false;
    }
}

function startSharedStateSync() {
    if (sharedStateSyncTimer) clearInterval(sharedStateSyncTimer);
    sharedStateSyncTimer = setInterval(syncSharedState, 5000);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            syncSharedState();
            loadPatientsFromGoogleSheets(false);
        }
    });
}

/* =========================================================
   GOOGLE SHEETS
========================================================= */

async function savePatientToGoogleSheets(patient) {

    try {

        const response =
            await fetch(
                GOOGLE_SCRIPT_URL,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "text/plain;charset=utf-8"
                    },

                    body: JSON.stringify({

                        action:
                            "savePatient",

                        token:
                            editingPatientId ? adminToken : "",

                        patient:
                            patient

                    })
                }
            );


        const result =
            await response.json();


        if (!result.ok) {

            throw new Error(
                result.error ||
                "Failed to save patient."
            );

        }


        console.log(
            "Patient saved to Google Sheets:",
            result
        );


        return result;

    }

    catch (error) {

        console.error(
            "Google Sheets save error:",
            error
        );

        throw error;

    }

}


/* =========================================================
   LOAD PATIENTS FROM GOOGLE SHEETS
========================================================= */

async function loadPatientsFromGoogleSheets(strict = false) {

    try {

        const response =
            await fetch(
                GOOGLE_SCRIPT_URL,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "text/plain;charset=utf-8"
                    },

                    body: JSON.stringify({

                        action:
                            "getPatients"

                    })
                }
            );


        const result =
            await response.json();


        if (!result.ok) {

            throw new Error(
                result.error ||
                "Failed to load patients."
            );

        }


        patients =
            result.patients || [];

        patientsStateVersion = String(result.version || "");

        persistAll();

        renderPatients();


        console.log(
            "Patients loaded from Google Sheets:",
            patients.length
        );


        return patients;

    }

    catch (error) {

        console.error(
            "Google Sheets load error:",
            error
        );

        if (strict) {
            throw error;
        }

        return [];

    }

}


/* =========================================================
   GOOGLE SHEETS PATIENT OPERATIONS
========================================================= */

async function deletePatientFromGoogleSheets(patientId) {

    const response = await fetch(
        GOOGLE_SCRIPT_URL,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "text/plain;charset=utf-8"
            },
            body: JSON.stringify({
                action: "deletePatient",
                token: adminToken,
                patientId: patientId
            })
        }
    );

    const result = await response.json();

    if (!result.ok) {
        throw new Error(
            result.error ||
            "Failed to delete patient."
        );
    }

    return result;
}


async function getNextUHIDFromGoogleSheets(camp) {

    const response = await fetch(
        GOOGLE_SCRIPT_URL,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "text/plain;charset=utf-8"
            },
            body: JSON.stringify({
                action: "getNextUHID",
                campId: camp.id,
                campName: camp.name
            })
        }
    );

    const result = await response.json();

    if (!result.ok) {
        throw new Error(
            result.error ||
            "Failed to generate UHID."
        );
    }

    return result.uhid;
}


/* =========================================================
   SHARED LETTERHEAD CONFIGURATION
   Stored centrally in Google Apps Script + Drive so every
   tablet uses the same saved letterhead and margins.
========================================================= */

async function loadSharedLetterheadConfiguration() {
    return loadSharedState(false);
}

async function saveSharedLetterheadConfiguration(options = {}) {
    return saveSharedState(options);
}


/* =========================================================
   DEFAULT CONFIG
========================================================= */

const DEFAULT_CONFIG = {

    activeCampId: "",

    letterhead: "",

    letterheadType: "",
    letterheadFileName: "",

    letterheadProfiles: {},

    margins: {

        top: 50,

        right: 15,

        bottom: 20,

        left: 15

    }

};


/* =========================================================
   STORAGE
========================================================= */

let config =
    loadConfiguration();


let camps =
    JSON.parse(
        localStorage.getItem(
            "medicalCampCamps"
        ) || "[]"
    );


let doctors =
    JSON.parse(
        localStorage.getItem(
            "medicalCampDoctors"
        ) || "[]"
    );


let patients =
    JSON.parse(
        localStorage.getItem(
            "medicalCampPatients"
        ) || "[]"
    );


let currentPhoto = "";
let currentPhotoFileId = "";
let cameraStream = null;
let isAdmin = false;
let editingPatientId = "";
let patientSearchQuery = "";
let uhidPreviewRequest = 0;


/* =========================================================
   CONFIGURATION
========================================================= */

function loadConfiguration() {

    try {

        const saved =
            JSON.parse(
                localStorage.getItem(
                    "medicalCampConfiguration"
                )
            );


        return {

            ...DEFAULT_CONFIG,

            ...(saved || {}),

            margins: {

                ...DEFAULT_CONFIG.margins,

                ...(
                    saved?.margins || {}
                )

            },

            letterheadProfiles: {

                ...(saved?.letterheadProfiles || {})

            }

        };

    }

    catch {

        return {
            ...DEFAULT_CONFIG
        };

    }

}


/* =========================================================
   INITIAL SAMPLE CAMP
========================================================= */

function initializeDefaultCamp() {

    if (camps.length === 0) {

        const defaultCamp = {

            id:
                createId("CAMP"),

            name:
                "Medical Camp",

            date:
                new Date()
                    .toISOString()
                    .split("T")[0]

        };


        camps.push(
            defaultCamp
        );


        localStorage.setItem(
            "medicalCampCamps",
            JSON.stringify(camps)
        );

    }


    if (!config.activeCampId ||
        !camps.some(
            c =>
                c.id ===
                config.activeCampId
        )) {

        config.activeCampId =
            camps[0].id;

    }

}


/* =========================================================
   ID GENERATOR
========================================================= */

function createId(prefix) {

    return (
        prefix +
        "_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .substring(2, 8)
    );

}


/* =========================================================
   ACTIVE CAMP
========================================================= */

function getActiveCamp() {

    return camps.find(
        camp =>
            camp.id ===
            config.activeCampId
    ) || camps[0];

}


/* =========================================================
   UHID PREFIX
========================================================= */

function campPrefix(name) {

    let prefix =
        String(name || "CAMP")
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");


    if (!prefix) {

        prefix =
            "CAMP";

    }


    /*
       Keep prefix reasonably short
       for a clean UHID.
    */

    return prefix
        .substring(0, 18);

}


/* =========================================================
   GENERATE UHID
========================================================= */

function generateUHID(camp) {

    const prefix =
        campPrefix(camp?.name);

    const campPatients =
        patients.filter(
            p => p.campId === camp.id
        );

    let highest = 0;

    campPatients.forEach(patient => {

        const match = String(patient.id || "")
            .match(/-(\d+)$/);

        if (match) {
            highest = Math.max(
                highest,
                Number(match[1])
            );
        }
    });

    return (
        prefix +
        "-" +
        String(highest + 1)
            .padStart(4, "0")
    );

}



/* =========================================================
   SAVE EVERYTHING
========================================================= */

function persistAll() {

    localStorage.setItem(
        "medicalCampConfiguration",
        JSON.stringify(config)
    );


    localStorage.setItem(
        "medicalCampCamps",
        JSON.stringify(camps)
    );


    localStorage.setItem(
        "medicalCampDoctors",
        JSON.stringify(doctors)
    );


    localStorage.setItem(
        "medicalCampPatients",
        JSON.stringify(patients)
    );

}


/* =========================================================
   CAMP MANAGEMENT
========================================================= */

async function addCamp() {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const input = document.getElementById("newCampName");
    const name = input.value.trim();
    if (!name) { alert("Please enter a camp name."); return; }

    const camp = {
        id: createId("CAMP"),
        name,
        date: new Date().toISOString().split("T")[0]
    };

    camps.push(camp);
    config.activeCampId = camp.id;
    input.value = "";
    sharedStateDirty = true;
    renderAdminLists();
    updateApplication();

    try {
        await saveSharedState();
        showStatus("adminStatus", "Camp added and synchronized to all tablets.", "success");
    } catch (error) {
        alert("Camp could not be saved centrally.\n\n" + error.message);
        await loadSharedState(false);
    }
}


/* =========================================================
   DELETE CAMP
========================================================= */

async function deleteCamp(id) {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    if (camps.length <= 1) { alert("At least one camp must remain."); return; }
    const camp = camps.find(c => c.id === id);
    if (!camp) return;

    const hasPatients = patients.some(p => p.campId === id);
    if (hasPatients && !confirm("Patients are already registered for this camp. Delete the camp configuration anyway?")) return;

    const previous = JSON.stringify({ camps, doctors, config });
    camps = camps.filter(c => c.id !== id);
    doctors = doctors.filter(d => d.campId !== id);
    if (config.activeCampId === id) config.activeCampId = camps[0].id;
    sharedStateDirty = true;
    renderAdminLists();
    updateApplication();

    try {
        await saveSharedState();
        showStatus("adminStatus", "Camp deleted and synchronized to all tablets.", "success");
    } catch (error) {
        const old = JSON.parse(previous);
        camps = old.camps; doctors = old.doctors; config = old.config;
        sharedStateDirty = false;
        renderAdminLists(); updateApplication();
        alert("Camp could not be deleted centrally.\n\n" + error.message);
    }
}


/* =========================================================
   ACTIVE CAMP SELECT
========================================================= */

async function changeActiveCamp() {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const select = document.getElementById("activeCampSelect");
    const previous = config.activeCampId;
    config.activeCampId = select.value;
    sharedStateDirty = true;
    updateApplication();
    renderAdminLists();

    try {
        await saveSharedState();
        showStatus("adminStatus", "Active camp changed. All tablets will sync automatically.", "success");
    } catch (error) {
        config.activeCampId = previous;
        sharedStateDirty = false;
        renderAdminLists(); updateApplication();
        alert("Active camp could not be synchronized.\n\n" + error.message);
    }
}


/* =========================================================
   DOCTOR MANAGEMENT
========================================================= */

async function addDoctor() {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const name = document.getElementById("newDoctorName").value.trim();
    const campId = document.getElementById("newDoctorCamp").value;
    if (!name) { alert("Please enter doctor name."); return; }
    if (!campId) { alert("Please select a camp."); return; }

    doctors.push({ id: createId("DR"), name, campId });
    document.getElementById("newDoctorName").value = "";
    sharedStateDirty = true;
    renderAdminLists(); updateDoctorDropdown();

    try {
        await saveSharedState();
        showStatus("adminStatus", "Doctor added and synchronized to all tablets.", "success");
    } catch (error) {
        await loadSharedState(false);
        alert("Doctor could not be saved centrally.\n\n" + error.message);
    }
}


/* =========================================================
   DELETE DOCTOR
========================================================= */

async function deleteDoctor(id) {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const previous = JSON.stringify(doctors);
    doctors = doctors.filter(d => d.id !== id);
    sharedStateDirty = true;
    renderAdminLists(); updateDoctorDropdown();
    try {
        await saveSharedState();
        showStatus("adminStatus", "Doctor deleted and synchronized to all tablets.", "success");
    } catch (error) {
        doctors = JSON.parse(previous); sharedStateDirty = false;
        renderAdminLists(); updateDoctorDropdown();
        alert("Doctor could not be deleted centrally.\n\n" + error.message);
    }
}


/* =========================================================
   EDIT CAMP / DOCTOR
========================================================= */

async function editCamp(id) {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const camp = camps.find(c => c.id === id); if (!camp) return;
    const name = prompt("Edit camp name:", camp.name); if (name === null) return;
    const cleanName = name.trim(); if (!cleanName) { alert("Camp name cannot be empty."); return; }
    const oldName = camp.name;
    camp.name = cleanName;
    sharedStateDirty = true;
    renderAdminLists(); updateApplication();
    try {
        await saveSharedState();
        showStatus("adminStatus", "Camp updated and synchronized to all tablets.", "success");
    } catch (error) {
        camp.name = oldName; sharedStateDirty = false;
        renderAdminLists(); updateApplication();
        alert("Camp could not be updated centrally.\n\n" + error.message);
    }
}


async function editDoctor(id) {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const doctor = doctors.find(d => d.id === id); if (!doctor) return;
    const name = prompt("Edit doctor name:", doctor.name); if (name === null) return;
    const cleanName = name.trim(); if (!cleanName) { alert("Doctor name cannot be empty."); return; }
    const campName = prompt("Enter the camp name for this doctor:", camps.find(c => c.id === doctor.campId)?.name || "");
    const old = { name: doctor.name, campId: doctor.campId };
    doctor.name = cleanName;
    if (campName !== null && campName.trim()) {
        const camp = camps.find(c => c.name.toLowerCase() === campName.trim().toLowerCase());
        if (camp) doctor.campId = camp.id;
    }
    sharedStateDirty = true;
    renderAdminLists(); updateDoctorDropdown();
    try {
        await saveSharedState();
        showStatus("adminStatus", "Doctor updated and synchronized to all tablets.", "success");
    } catch (error) {
        doctor.name = old.name; doctor.campId = old.campId; sharedStateDirty = false;
        renderAdminLists(); updateDoctorDropdown();
        alert("Doctor could not be updated centrally.\n\n" + error.message);
    }
}


/* =========================================================
   ADMIN LISTS
========================================================= */

function renderAdminLists() {

    renderCampList();

    renderDoctorList();

    renderCampSelects();

}


function renderCampList() {

    const list =
        document.getElementById(
            "campList"
        );


    list.innerHTML = "";


    camps.forEach(
        camp => {

            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "admin-list-row";


            row.innerHTML = `

                <div>

                    <div class="admin-list-name">

                        ${escapeHtml(camp.name)}

                    </div>

                    <div class="admin-list-meta">

                        ${camp.date
                    ? formatDate(camp.date)
                    : "Date not set"}

                    </div>

                </div>

                <div style="display:flex;gap:6px;">

                    <button
                        class="btn btn-secondary"
                        onclick="editCamp('${camp.id}')">

                        Edit

                    </button>

                    <button
                        class="btn btn-danger"
                        onclick="deleteCamp('${camp.id}')">

                        Delete

                    </button>

                </div>

            `;


            list.appendChild(
                row
            );

        }
    );

}


function renderDoctorList() {

    const list =
        document.getElementById(
            "doctorList"
        );


    list.innerHTML = "";


    if (doctors.length === 0) {

        list.innerHTML = `

            <div
                style="
                    padding:15px;
                    color:#667085;
                    font-size:11px;
                ">

                No doctors added yet.

            </div>

        `;

        return;

    }


    doctors.forEach(
        doctor => {

            const camp =
                camps.find(
                    c =>
                        c.id ===
                        doctor.campId
                );


            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "admin-list-row";


            row.innerHTML = `

                <div>

                    <div class="admin-list-name">

                        ${escapeHtml(doctor.name)}

                    </div>

                    <div class="admin-list-meta">

                        Camp:
                        ${escapeHtml(
                camp?.name ||
                "Unknown"
            )}

                    </div>

                </div>

                <div style="display:flex;gap:6px;">

                    <button
                        class="btn btn-secondary"
                        onclick="editDoctor('${doctor.id}')">

                        Edit

                    </button>

                    <button
                        class="btn btn-danger"
                        onclick="deleteDoctor('${doctor.id}')">

                        Delete

                    </button>

                </div>

            `;


            list.appendChild(
                row
            );

        }
    );

}


/* =========================================================
   CAMP DROPDOWNS
========================================================= */

function renderCampSelects() {

    const activeSelect =
        document.getElementById(
            "activeCampSelect"
        );


    const doctorCampSelect =
        document.getElementById(
            "newDoctorCamp"
        );


    activeSelect.innerHTML = "";

    doctorCampSelect.innerHTML = "";


    camps.forEach(
        camp => {

            const option1 =
                document.createElement(
                    "option"
                );

            option1.value =
                camp.id;

            option1.textContent =
                camp.name;

            if (
                camp.id ===
                config.activeCampId
            ) {

                option1.selected =
                    true;

            }

            activeSelect.appendChild(
                option1
            );


            const option2 =
                document.createElement(
                    "option"
                );

            option2.value =
                camp.id;

            option2.textContent =
                camp.name;

            doctorCampSelect.appendChild(
                option2
            );

        }
    );

}


/* =========================================================
   DOCTOR DROPDOWN
========================================================= */

function updateDoctorDropdown() {

    const select =
        document.getElementById(
            "doctor"
        );


    const previous =
        select.value;


    select.innerHTML = `

        <option value="">
            Select Doctor
        </option>

    `;


    const activeCamp =
        getActiveCamp();


    if (!activeCamp) return;


    const campDoctors =
        doctors.filter(
            doctor =>
                doctor.campId ===
                activeCamp.id
        );


    campDoctors.forEach(
        doctor => {

            const option =
                document.createElement(
                    "option"
                );


            option.value =
                doctor.name;


            option.textContent =
                doctor.name;


            select.appendChild(
                option
            );

        }
    );


    if (
        campDoctors.some(
            d =>
                d.name ===
                previous
        )
    ) {

        select.value =
            previous;

    }

}


/* =========================================================
   LETTERHEAD-SPECIFIC PRINT SETTINGS
========================================================= */

function getLetterheadProfileKey() {

    return String(
        config.letterheadFileName ||
        "default-letterhead"
    ).trim().toLowerCase();

}

function getCurrentLetterheadSettings() {

    const key = getLetterheadProfileKey();
    const saved =
        (config.letterheadProfiles || {})[key] || {};

    return {
        top: validNumber(Number(saved.top ?? config.margins?.top), 50),
        right: validNumber(Number(saved.right ?? config.margins?.right), 15),
        bottom: validNumber(Number(saved.bottom ?? config.margins?.bottom), 20),
        left: validNumber(Number(saved.left ?? config.margins?.left), 15)
    };
}

function loadLetterheadSettingsToAdmin() {

    const settings = getCurrentLetterheadSettings();

    const top = document.getElementById("marginTop");
    const right = document.getElementById("marginRight");
    const bottom = document.getElementById("marginBottom");
    const left = document.getElementById("marginLeft");

    if (top) top.value = settings.top;
    if (right) right.value = settings.right;
    if (bottom) bottom.value = settings.bottom;
    if (left) left.value = settings.left;

    updateLetterheadMarginPreview();
}

function saveCurrentLetterheadSettings(settings) {

    if (!config.letterheadProfiles) {
        config.letterheadProfiles = {};
    }

    const key = getLetterheadProfileKey();

    config.letterheadProfiles[key] = {
        top: settings.top,
        right: settings.right,
        bottom: settings.bottom,
        left: settings.left
    };

    config.margins = {
        top: settings.top,
        right: settings.right,
        bottom: settings.bottom,
        left: settings.left
    };
}

/* =========================================================
   ADMIN LETTERHEAD PREVIEW
========================================================= */

function updateLetterheadMarginPreview() {

    const preview = document.getElementById("letterheadMarginPreview");
    const sheet = document.getElementById("letterheadMarginPreviewSheet");
    const header = document.getElementById("letterheadMarginPreviewHeader");
    const content = document.getElementById("letterheadMarginPreviewContent");
    const footer = document.getElementById("letterheadMarginPreviewFooter");
    const values = document.getElementById("letterheadMarginPreviewValues");

    if (!preview || !sheet || !header || !content || !footer) return;

    if (!config.letterhead) {
        preview.style.display = "none";
        return;
    }

    const settings = getCurrentLetterheadSettings();
    const top = validNumber(Number(settings.top), 50);
    const right = validNumber(Number(settings.right), 15);
    const bottom = validNumber(Number(settings.bottom), 20);
    const left = validNumber(Number(settings.left), 15);

    preview.style.display = "block";
    sheet.style.backgroundImage = `url("${config.letterhead}")`;

    const pageHeight = 148;
    const pageWidth = 210;

    const topPct = Math.min(95, Math.max(0, top / pageHeight * 100));
    const bottomPct = Math.min(95, Math.max(0, bottom / pageHeight * 100));
    const leftPct = Math.min(45, Math.max(0, left / pageWidth * 100));
    const rightPct = Math.min(45, Math.max(0, right / pageWidth * 100));

    header.style.height = `${topPct}%`;
    footer.style.height = `${bottomPct}%`;

    content.style.top = `${topPct}%`;
    content.style.bottom = `${bottomPct}%`;
    content.style.left = `${leftPct}%`;
    content.style.right = `${rightPct}%`;
    content.style.width = `${Math.max(10, 100 - leftPct - rightPct)}%`;
    content.style.height = `${Math.max(5, 100 - topPct - bottomPct)}%`;

    if (values) {
        values.textContent =
            `Header ${top} mm  •  Footer ${bottom} mm  •  Left ${left} mm  •  Right ${right} mm`;
    }
}

/* =========================================================
   CONFIGURATION SAVE
========================================================= */

async function saveConfiguration() {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    const marginTop = Number(document.getElementById("marginTop").value);
    const marginRight = Number(document.getElementById("marginRight").value);
    const marginBottom = Number(document.getElementById("marginBottom").value);
    const marginLeft = Number(document.getElementById("marginLeft").value);

    saveCurrentLetterheadSettings({
        top: validNumber(marginTop, 50),
        right: validNumber(marginRight, 15),
        bottom: validNumber(marginBottom, 20),
        left: validNumber(marginLeft, 15)
    });

    sharedStateDirty = true;
    updateApplication();
    loadLetterheadSettingsToAdmin();
    updateLetterheadMarginPreview();
    showStatus("adminStatus", "Saving central configuration...", "success");

    try {
        await saveSharedState({
            letterheadData: (config.letterhead || "").startsWith("data:image/") ? config.letterhead : ""
        });
        showStatus("adminStatus", "Saved centrally. All tablets now use this configuration.", "success");
    } catch (error) {
        sharedStateDirty = false;
        await loadSharedState(false);
        showStatus("adminStatus", "Central save failed: " + error.message, "error");
    }
}


/* =========================================================
   LETTERHEAD
========================================================= */

function handleLetterhead(event) {

    const file =
        event.target.files[0];


    if (!file) return;


    const allowed = [
        "image/png",
        "image/jpeg",
        "application/pdf"
    ];


    if (!allowed.includes(file.type)) {

        alert(
            "Please upload a PNG, JPG, JPEG or PDF letterhead."
        );

        event.target.value = "";

        return;

    }


    const container =
        document.getElementById(
            "letterheadPreviewContainer"
        );


    const image =
        document.getElementById(
            "letterheadPreview"
        );


    const pdf =
        document.getElementById(
            "letterheadPdfPreview"
        );


    const name =
        document.getElementById(
            "letterheadFileName"
        );


    container.style.display =
        "block";


    name.textContent =
        file.name;


    /* ---------------------------------------------------------
       IMAGE LETTERHEAD
       Store it directly. It will be used as the print background.
    --------------------------------------------------------- */

    if (
        file.type !==
        "application/pdf"
    ) {

        const reader =
            new FileReader();


        reader.onload =
            function (e) {

                config.letterhead =
                    e.target.result;


                config.letterheadType =
                    "image";


                config.letterheadFileName =
                    file.name;

                sharedStateDirty = true;

                const settings = getCurrentLetterheadSettings();
                config.margins = { ...settings };
                loadLetterheadSettingsToAdmin();


                image.src =
                    e.target.result;


                image.style.display =
                    "block";


                pdf.src =
                    "";


                pdf.style.display =
                    "none";


                updatePrintStyles();


                showStatus(
                    "adminStatus",
                    "Letterhead uploaded. Click Save Configuration.",
                    "success"
                );

            };


        reader.onerror =
            function () {

                alert(
                    "Unable to read the selected letterhead."
                );

                event.target.value =
                    "";

            };


        reader.readAsDataURL(
            file
        );


        return;

    }


    /* ---------------------------------------------------------
       PDF LETTERHEAD
       Convert page 1 to a PNG so Chrome prints the exact
       uploaded letterhead together with the patient content.
    --------------------------------------------------------- */

    if (
        typeof pdfjsLib ===
        "undefined"
    ) {

        alert(
            "PDF support is not loaded. Please check your internet connection and reload the page."
        );

        event.target.value =
            "";

        return;

    }


    const reader =
        new FileReader();


    reader.onload =
        async function (e) {

            try {

                const pdfData =
                    new Uint8Array(
                        e.target.result
                    );


                const loadingTask =
                    pdfjsLib.getDocument({
                        data: pdfData
                    });


                const pdfDocument =
                    await loadingTask.promise;


                const page =
                    await pdfDocument.getPage(
                        1
                    );


                /* Render at high resolution for clean A5 printing. */

                const baseViewport =
                    page.getViewport({
                        scale: 1
                    });


                const targetWidth =
                    1240;


                const scale =
                    targetWidth /
                    baseViewport.width;


                const viewport =
                    page.getViewport({
                        scale
                    });


                const canvas =
                    document.createElement(
                        "canvas"
                    );


                const context =
                    canvas.getContext(
                        "2d",
                        {
                            alpha: false
                        }
                    );


                canvas.width =
                    Math.ceil(
                        viewport.width
                    );


                canvas.height =
                    Math.ceil(
                        viewport.height
                    );


                await page.render({

                    canvasContext:
                        context,

                    viewport:
                        viewport,

                    background:
                        "white"

                }).promise;


                const imageData =
                    canvas.toDataURL(
                        "image/png"
                    );


                config.letterhead =
                    imageData;


                config.letterheadType =
                    "image";


                config.letterheadFileName =
                    file.name;

                sharedStateDirty = true;

                const settings = getCurrentLetterheadSettings();
                config.margins = { ...settings };
                loadLetterheadSettingsToAdmin();


                image.src =
                    imageData;


                image.style.display =
                    "block";


                pdf.src =
                    "";


                pdf.style.display =
                    "none";


                updatePrintStyles();


                showStatus(
                    "adminStatus",
                    "PDF letterhead loaded. Click Save Configuration.",
                    "success"
                );

            }

            catch (error) {

                console.error(
                    "LETTERHEAD PDF ERROR:",
                    error
                );


                alert(
                    "Unable to read this PDF letterhead."
                );


                event.target.value =
                    "";

            }

        };


    reader.onerror =
        function () {

            alert(
                "Unable to read the selected PDF letterhead."
            );


            event.target.value =
                "";

        };


    reader.readAsArrayBuffer(
        file
    );

}


async function deleteLetterhead(showMessage = true) {
    if (!isAdmin || !adminToken) { alert("Admin access is required."); return; }
    if (showMessage && !confirm("Are you sure you want to delete the current letterhead?")) return;

    config.letterhead = "";
    config.letterheadType = "";
    config.letterheadFileName = "";
    config.letterheadFileId = "";
    config.letterheadProfiles = {};
    config.margins = { ...DEFAULT_CONFIG.margins };

    const input = document.getElementById("letterheadInput"); if (input) input.value = "";
    const image = document.getElementById("letterheadPreview"); if (image) { image.src = ""; image.style.display = "none"; }
    const pdf = document.getElementById("letterheadPdfPreview"); if (pdf) { pdf.src = ""; pdf.style.display = "none"; }
    const container = document.getElementById("letterheadPreviewContainer"); if (container) container.style.display = "none";
    const name = document.getElementById("letterheadFileName"); if (name) name.textContent = "Letterhead";

    sharedStateDirty = true;
    updatePrintStyles(); updateLetterheadMarginPreview();

    try {
        await saveSharedState({ deleteLetterhead: true });
        if (showMessage) showStatus("adminStatus", "Letterhead deleted centrally. All tablets will update.", "success");
    } catch (error) {
        sharedStateDirty = false;
        await loadSharedState(false);
        alert("Letterhead could not be deleted centrally.\n\n" + error.message);
    }
}


function openAdmin() {

    const login =
        document.getElementById(
            "adminLoginModal"
        );


    if (login) {

        login.classList.add(
            "active"
        );


        document
            .getElementById(
                "adminUsername"
            )
            .focus();


        return;

    }


    openAdminPanel();

}


function openAdminPanel() {

    renderAdminLists();


    loadLetterheadSettingsToAdmin();


    const container =
        document.getElementById(
            "letterheadPreviewContainer"
        );


    const image =
        document.getElementById(
            "letterheadPreview"
        );


    const pdf =
        document.getElementById(
            "letterheadPdfPreview"
        );


    const name =
        document.getElementById(
            "letterheadFileName"
        );


    if (config.letterhead) {

        container.style.display =
            "block";


        name.textContent =
            config.letterheadFileName ||
            "Saved letterhead";


        if (
            config.letterheadType ===
            "pdf"
        ) {

            image.style.display =
                "none";


            pdf.src =
                config.letterhead;


            pdf.style.display =
                "block";

        }

        else {

            image.src =
                config.letterhead;


            image.style.display =
                "block";


            pdf.src =
                "";


            pdf.style.display =
                "none";

        }

    }

    else {

        container.style.display =
            "none";

    }


    updatePrintStyles();


    document
        .getElementById(
            "adminModal"
        )
        .classList.add(
            "active"
        );

}


function closeAdmin() {

    document
        .getElementById(
            "adminModal"
        )
        .classList.remove(
            "active"
        );

    renderPatients();

}


async function adminLogin(event) {
    event.preventDefault();
    const username = document.getElementById("adminUsername").value.trim();
    const password = document.getElementById("adminPassword").value;
    const status = document.getElementById("adminLoginStatus");
    status.className = "status";
    status.textContent = "Checking admin credentials...";

    try {
        await loginAdminOnServer(username, password);
        status.className = "status success";
        status.textContent = "Login successful.";
        setTimeout(() => {
            document.getElementById("adminLoginModal").classList.remove("active");
            document.getElementById("adminLoginForm").reset();
            status.className = "status";
            status.textContent = "";
            openAdminPanel();
        }, 250);
    } catch (error) {
        clearAdminSession();
        status.className = "status error";
        status.textContent = error.message || "Invalid username or password.";
    }
    return false;
}


function closeAdminLogin() {

    document
        .getElementById(
            "adminLoginModal"
        )
        .classList.remove(
            "active"
        );


    document
        .getElementById(
            "adminLoginForm"
        )
        .reset();


    document
        .getElementById(
            "adminLoginStatus"
        )
        .className =
        "status";

}


/* =========================================================
   UPDATE APPLICATION
========================================================= */

function updateApplication() {

    const camp =
        getActiveCamp();


    if (!camp) return;


    document
        .getElementById(
            "displayCampName"
        )
        .textContent =
        camp.name;


    document
        .getElementById(
            "displayCampDate"
        )
        .textContent =
        camp.date
            ? formatDate(camp.date)
            : "—";


    document
        .getElementById(
            "sideCampName"
        )
        .textContent =
        camp.name;


    document
        .getElementById(
            "sideCampDate"
        )
        .textContent =
        camp.date
            ? formatDate(camp.date)
            : "—";


    document
        .getElementById(
            "formCamp"
        )
        .value =
        camp.name;


    /*
       The visible UHID is only a preview.
       The final UHID is generated by Google Apps Script
       during registration, so multiple tablets cannot
       create the same number.
    */

    if (!editingPatientId) {

        const previewId =
            generateUHID(camp);

        document
            .getElementById(
                "patientId"
            )
            .value =
            previewId;

        updateUHIDPreviewFromServer(camp);

    }


    updateDoctorDropdown();

    updatePrintStyles();

}


async function updateUHIDPreviewFromServer(camp) {

    if (!camp || editingPatientId) return;


    const requestId =
        ++uhidPreviewRequest;


    try {

        const uhid =
            await getNextUHIDFromGoogleSheets(
                camp
            );


        /* Ignore an older request if the camp was changed again. */

        if (
            requestId !==
            uhidPreviewRequest
        ) {

            return;

        }


        const activeCamp =
            getActiveCamp();


        if (
            !activeCamp ||
            activeCamp.id !== camp.id ||
            editingPatientId
        ) {

            return;

        }


        document
            .getElementById(
                "patientId"
            )
            .value =
            uhid;

    }

    catch (error) {

        /*
           Keep the local preview if Google Sheets is temporarily
           unavailable. Registration itself will still require the
           server to generate the final UHID.
        */

        console.warn(
            "Unable to refresh UHID preview from Google Sheets:",
            error
        );

    }

}


function setPrintMarginVariables() {

    const margins = getCurrentLetterheadSettings();

    document.documentElement.style.setProperty(
        "--content-top",
        `${validNumber(Number(margins.top), 38)}mm`
    );

    document.documentElement.style.setProperty(
        "--content-right",
        `${validNumber(Number(margins.right), 8)}mm`
    );

    document.documentElement.style.setProperty(
        "--content-bottom",
        `${validNumber(Number(margins.bottom), 10)}mm`
    );

    document.documentElement.style.setProperty(
        "--content-left",
        `${validNumber(Number(margins.left), 8)}mm`
    );
}


/* =========================================================
   PRINT STYLES
========================================================= */

function updatePrintStyles() {

    setPrintMarginVariables();

    const content =
        document.getElementById(
            "printContent"
        );


    const sheet =
        document.querySelector(
            ".print-sheet"
        );


    const letterhead =
        document.getElementById(
            "printLetterhead"
        );


    /*
     * Determine the uploaded letterhead's
     * actual aspect ratio.
     */

    function applyOrientation(
        width,
        height
    ) {

        const isLandscape =
            width > height;


        if (isLandscape) {

            document.documentElement.style.setProperty(
                "--print-width",
                "210mm"
            );


            document.documentElement.style.setProperty(
                "--print-height",
                "148mm"
            );


            /*
             * Landscape letterhead usually has
             * more horizontal blank space.
             */

            setPrintMarginVariables();


            if (sheet) {

                sheet.style.width =
                    "210mm";


                sheet.style.height =
                    "148mm";

            }

        }

        else {

            document.documentElement.style.setProperty(
                "--print-width",
                "148mm"
            );


            document.documentElement.style.setProperty(
                "--print-height",
                "210mm"
            );


            setPrintMarginVariables();


            if (sheet) {

                sheet.style.width =
                    "148mm";


                sheet.style.height =
                    "210mm";

            }

        }

    }


    /*
     * Default to A5 portrait.
     */

    applyOrientation(
        148,
        210
    );


    /*
     * If a letterhead exists, load it and
     * detect its natural dimensions.
     */

    if (config.letterhead) {

        letterhead.style.backgroundImage =
            `url("${config.letterhead}")`;


        letterhead.style.display =
            "block";


        const img =
            new Image();


        img.onload =
            function () {

                applyOrientation(
                    img.naturalWidth,
                    img.naturalHeight
                );


                updatePrintDateTime();

            };


        img.src =
            config.letterhead;

    }

    else {

        letterhead.style.backgroundImage =
            "none";


        letterhead.style.display =
            "none";


        updatePrintDateTime();

    }

}


/* =========================================================
   PRINT CONTENT AUTO-FIT
========================================================= */

function fitPrintContentToAvailableArea() {

    const content = document.getElementById("printContent");
    if (!content) return;

    content.style.transform = "none";
    content.style.transformOrigin = "top left";
    content.style.width = "100%";

    const availableHeight = content.clientHeight;
    const requiredHeight = content.scrollHeight;

    if (!availableHeight || !requiredHeight || requiredHeight <= availableHeight) {
        return;
    }

    const scale = Math.max(0.72, availableHeight / requiredHeight);

    content.style.transform = `scale(${scale})`;
    content.style.width = `${100 / scale}%`;
}


/* =========================================================
   PRINT DATE & TIME
========================================================= */

function updatePrintDateTime() {

    const element =
        document.getElementById(
            "printDateTime"
        );


    if (!element) return;


    const now =
        new Date();


    const date =
        now.toLocaleDateString(
            "en-IN",
            {
                day:
                    "2-digit",

                month:
                    "short",

                year:
                    "numeric"

            }
        );


    const time =
        now.toLocaleTimeString(
            "en-IN",
            {
                hour:
                    "2-digit",

                minute:
                    "2-digit",

                second:
                    "2-digit",

                hour12:
                    true

            }
        );


    element.textContent =
        `Printed: ${date} | ${time}`;

}


/* =========================================================
   PHOTO UPLOAD
========================================================= */

function handlePhotoUpload(event) {

    const file =
        event.target.files[0];


    if (!file) return;


    const reader =
        new FileReader();


    reader.onload =
        function (e) {

            setPatientPhoto(
                e.target.result
            );

        };


    reader.readAsDataURL(
        file
    );

}


function setPatientPhoto(src) {

    currentPhoto =
        src;

    currentPhotoFileId = "";


    document
        .getElementById(
            "photoPreview"
        )
        .innerHTML = `

            <img
                src="${src}"
                alt="Patient Photo">

        `;

}


/* =========================================================
   CAMERA
========================================================= */

async function openCamera() {

    const modal =
        document.getElementById(
            "cameraModal"
        );


    modal.classList.add(
        "active"
    );


    try {

        cameraStream =
            await navigator
                .mediaDevices
                .getUserMedia({

                    video: {

                        facingMode:
                            "environment"

                    },

                    audio:
                        false

                });


        document
            .getElementById(
                "cameraVideo"
            )
            .srcObject =
            cameraStream;

    }

    catch {

        alert(
            "Camera access is unavailable. Please use Upload Photo instead."
        );


        closeCamera();

    }

}


function capturePhoto() {

    const video =
        document.getElementById(
            "cameraVideo"
        );


    const canvas =
        document.getElementById(
            "cameraCanvas"
        );


    canvas.width =
        video.videoWidth;


    canvas.height =
        video.videoHeight;


    const ctx =
        canvas.getContext(
            "2d"
        );


    ctx.drawImage(
        video,
        0,
        0,
        canvas.width,
        canvas.height
    );


    setPatientPhoto(
        canvas.toDataURL(
            "image/jpeg",
            .85
        )
    );


    closeCamera();

}


function closeCamera() {

    document
        .getElementById(
            "cameraModal"
        )
        .classList.remove(
            "active"
        );


    if (cameraStream) {

        cameraStream
            .getTracks()
            .forEach(
                track =>
                    track.stop()
            );


        cameraStream =
            null;

    }

}


/* =========================================================
   FORM SUBMIT
   Save directly to Google Sheets, then update the local UI
   and continue with the existing A5 print flow.
========================================================= */

document
    .getElementById(
        "patientForm"
    )
    .addEventListener(
        "submit",
        async function (event) {

            event.preventDefault();


            /*
               Refresh from Google Sheets before generating the UHID.
               This prevents two tablets from using stale patient counts.
            */

            try {

                await loadPatientsFromGoogleSheets(
                    true
                );

            }

            catch (error) {

                console.error(
                    "Unable to load Google Sheets before registration:",
                    error
                );


                alert(
                    "Unable to connect to Google Sheets.\n\nPlease check your internet connection and try again."
                );


                return;

            }


            const camp =
                getActiveCamp();


            if (!camp) {

                alert(
                    "Please configure a camp first."
                );


                return;

            }


            const patient = {

                id:
                    editingPatientId || "",

                name:
                    document
                        .getElementById(
                            "patientName"
                        )
                        .value
                        .trim(),

                age:
                    document
                        .getElementById(
                            "age"
                        )
                        .value,

                gender:
                    document
                        .getElementById(
                            "gender"
                        )
                        .value,

                mobile:
                    document
                        .getElementById(
                            "mobile"
                        )
                        .value
                        .trim(),

                blood:
                    document
                        .getElementById(
                            "bloodGroup"
                        )
                        .value,

                yeshasvini:
                    document
                        .getElementById(
                            "yeshasvini"
                        )
                        .value,

                doctor:
                    document
                        .getElementById(
                            "doctor"
                        )
                        .value,

                address:
                    document
                        .getElementById(
                            "address"
                        )
                        .value
                        .trim(),

                complaint:
                    document
                        .getElementById(
                            "complaint"
                        )
                        .value
                        .trim(),

                photo:
                    currentPhoto,

                photoFileId:
                    currentPhotoFileId,

                campId:
                    camp.id,

                campName:
                    camp.name,

                campDate:
                    camp.date,

                registeredAt:
                    editingPatientId
                        ? (patients.find(p => p.id === editingPatientId)?.registeredAt || new Date().toISOString())
                        : new Date().toISOString(),

                generateServerUHID:
                    !editingPatientId

            };


            const submitButton =
                document.querySelector(
                    '#patientForm button[type="submit"]'
                );


            const originalButtonText =
                submitButton
                    ? submitButton.textContent
                    : "";


            if (submitButton) {

                submitButton.disabled =
                    true;


                submitButton.textContent =
                    "Saving...";

            }


            try {

                /*
                   Google Sheets is the primary save.
                   Do not print until this succeeds.
                */

                const saveResult =
                    await savePatientToGoogleSheets(
                        patient
                    );


                const savedPatient =
                    saveResult.patient ||
                    patient;


                Object.assign(
                    patient,
                    savedPatient
                );

                /* Always keep the server-generated UHID as the final
                   value used by the patient record and print output. */
                patient.id = String(
                    savedPatient.id ||
                    saveResult.patientId ||
                    patient.id ||
                    document.getElementById("patientId")?.value ||
                    ""
                ).trim();


                /* Show the final server-generated UHID immediately. */
                document
                    .getElementById(
                        "patientId"
                    )
                    .value =
                    patient.id;


                if (editingPatientId) {

                    const index =
                        patients.findIndex(
                            p => p.id === editingPatientId
                        );

                    if (index >= 0) {
                        patients[index] = patient;
                    } else {
                        patients.unshift(patient);
                    }

                } else {

                    patients.unshift(patient);

                }


                persistAll();

                editingPatientId = "";

                renderPatients();

                preparePrint(
                    patient
                );

            }

            catch (error) {

                console.error(
                    "Patient save failed:",
                    error
                );


                alert(
                    "Patient could not be saved to Google Sheets.\n\nPlease check your internet connection and try again."
                );


                return;

            }

            finally {

                if (submitButton) {

                    submitButton.disabled =
                        false;


                    submitButton.textContent =
                        "✓ Register Patient & Print";

                }

            }

        }
    );


function preparePrint(patient) {

    document.getElementById("printPatientId").textContent =
        patient.id || "";

    document.getElementById("printPatientName").textContent =
        patient.name || "";

    document.getElementById("printAge").textContent =
        patient.age || "";

    document.getElementById("printGender").textContent =
        patient.gender || "";

    document.getElementById("printMobile").textContent =
        patient.mobile || "-";

    document.getElementById("printBlood").textContent =
        patient.blood || "-";

    document.getElementById("printYeshasvini").textContent =
        patient.yeshasvini || "-";

    document.getElementById("printDoctor").textContent =
        patient.doctor || "-";

    document.getElementById("printCamp").textContent =
        patient.campName || "-";

    document.getElementById("printAddress").textContent =
        patient.address || "-";

    document.getElementById("printComplaint").textContent =
        patient.complaint || "-";

    document.getElementById("printCampName").textContent =
        patient.campName || "";

    document.getElementById("printCampDate").textContent =
        patient.campDate
            ? formatDate(patient.campDate)
            : "";

    const photo = document.getElementById("printPhoto");

    /*
     * ---------------------------------------------------------
     * PATIENT PHOTO
     * ---------------------------------------------------------
     */

    if (!photo) {
        console.error("printPhoto element not found.");
        return;
    }

    photo.style.display = "none";
    photo.removeAttribute("src");

    function startPrinting() {
        updatePrintDateTime();
        updatePrintStyles();
        fitPrintContentToAvailableArea();

        setTimeout(function () {
            window.print();
        }, 150);
    }

    if (patient.photo) {

        photo.onload = function () {

            photo.style.display = "block";

            startPrinting();
        };

        photo.onerror = function () {

            console.error(
                "Patient photo failed to load:",
                patient.photo
            );

            photo.style.display = "none";

            startPrinting();
        };

        photo.src = patient.photo;

        /*
         * If browser already has the image cached,
         * onload may have already completed.
         */
        if (photo.complete && photo.naturalWidth > 0) {
            photo.style.display = "block";
            startPrinting();
        }

    } else {

        startPrinting();
    }
}


/* =========================================================
   PRINT EXISTING
========================================================= */

function printExistingPatient(id) {

    const patient =
        patients.find(
            p =>
                p.id ===
                id
        );


    if (!patient) return;


    document.title =
        `${patient.name}_${patient.id}`;


    preparePrint(
        patient
    );

}


/* =========================================================
   PATIENT TABLE
========================================================= */

function renderPatients() {

    const tbody =
        document.getElementById(
            "patientTableBody"
        );

    tbody.innerHTML = "";

    const query =
        String(patientSearchQuery || "")
            .trim()
            .toLowerCase();

    const filtered =
        patients.filter(patient => {

            if (!query) return true;

            const haystack = [
                patient.id,
                patient.name,
                patient.mobile,
                patient.doctor,
                patient.campName,
                patient.age,
                patient.gender
            ]
                .map(value => String(value || "").toLowerCase())
                .join(" ");

            return haystack.includes(query);
        });

    filtered
        .slice(0, 100)
        .forEach(patient => {

            const row =
                document.createElement("tr");

            const yesBadge =
                patient.yeshasvini === "Yes"
                    ? `<span class="badge badge-yes">YES</span>`
                    : `<span class="badge badge-no">${patient.yeshasvini || "—"}</span>`;

            let actions = `
                <button
                    class="btn btn-secondary"
                    onclick="printExistingPatient('${escapeJs(patient.id)}')">
                    Print
                </button>
            `;

            if (isAdmin) {

                actions += `
                    <button
                        class="btn btn-primary"
                        onclick="editExistingPatient('${escapeJs(patient.id)}')">
                        Edit
                    </button>

                    <button
                        class="btn btn-danger"
                        onclick="deleteExistingPatient('${escapeJs(patient.id)}')">
                        Delete
                    </button>
                `;
            }

            row.innerHTML = `
                <td>
                    ${patient.photo
                        ? `<img src="${patient.photo}" class="patient-thumb" alt="Photo">`
                        : "—"}
                </td>

                <td>${escapeHtml(patient.id)}</td>
                <td>${escapeHtml(patient.name)}</td>
                <td>${escapeHtml(patient.age)}</td>
                <td>${escapeHtml(patient.gender)}</td>
                <td>${yesBadge}</td>
                <td>${escapeHtml(patient.doctor || "—")}</td>
                <td>${escapeHtml(patient.campName || "—")}</td>
                <td>${escapeHtml(patient.mobile || "—")}</td>
                <td>
                    <div style="display:flex;gap:5px;flex-wrap:wrap;">
                        ${actions}
                    </div>
                </td>
            `;

            tbody.appendChild(row);
        });

    document
        .getElementById("patientCount")
        .textContent =
        query
            ? `${filtered.length} / ${patients.length}`
            : patients.length;

}


function searchPatients(value) {

    patientSearchQuery = value || "";

    renderPatients();

}


async function deleteExistingPatient(id) {

    if (!isAdmin) {
        alert("Admin access is required to delete patients.");
        return;
    }

    const patient =
        patients.find(p => p.id === id);

    if (!patient) return;

    const confirmed =
        confirm(
            `Delete patient ${patient.name} (${patient.id})?\n\nThis will permanently remove the record from Google Sheets.`
        );

    if (!confirmed) return;

    try {

        await deletePatientFromGoogleSheets(id);

        patients =
            patients.filter(p => p.id !== id);

        persistAll();
        renderPatients();

        alert("Patient deleted successfully.");

    } catch (error) {

        console.error(
            "Patient deletion failed:",
            error
        );

        alert(
            "Unable to delete the patient from Google Sheets.\n\n" +
            error.message
        );
    }

}


function editExistingPatient(id) {

    if (!isAdmin) {
        alert("Admin access is required to edit patients.");
        return;
    }

    const patient =
        patients.find(p => p.id === id);

    if (!patient) return;

    editingPatientId = patient.id;

    const setValue = (elementId, value) => {
        const element = document.getElementById(elementId);
        if (element) element.value = value || "";
    };

    setValue("patientName", patient.name);
    setValue("age", patient.age);
    setValue("gender", patient.gender);
    setValue("mobile", patient.mobile);
    setValue("bloodGroup", patient.blood);
    setValue("yeshasvini", patient.yeshasvini);
    setValue("doctor", patient.doctor);
    setValue("address", patient.address);
    setValue("complaint", patient.complaint);
    setValue("patientId", patient.id);
    setValue("formCamp", patient.campName);

    currentPhoto = "";
    currentPhotoFileId = patient.photoFileId || "";

    const preview =
        document.getElementById("photoPreview");

    if (preview) {
        preview.innerHTML = patient.photo
            ? `<img src="${patient.photo}" alt="Patient Photo">`
            : "No Photo";
    }

    const submitButton =
        document.querySelector(
            '#patientForm button[type="submit"]'
        );

    if (submitButton) {
        submitButton.textContent =
            "✓ Update Patient & Print";
    }

    document
        .getElementById("patientForm")
        .scrollIntoView({
            behavior: "smooth",
            block: "start"
        });

}



/* =========================================================
   EXCEL DOWNLOAD
========================================================= */

/*
   This creates an Excel-compatible .xls file.

   It does not require any external library.
*/

function downloadExcel() {

    if (
        patients.length ===
        0
    ) {

        alert(
            "There are no patient records to export."
        );


        return;

    }


    let html = `

        <html>

        <head>

            <meta charset="UTF-8">

            <style>

                table {
                    border-collapse:collapse;
                }

                th {
                    background:#0b6e69;
                    color:white;
                    font-weight:bold;
                }

                th, td {
                    border:1px solid #999;
                    padding:7px;
                }

            </style>

        </head>

        <body>

        <table>

        <tr>

            <th>UHID</th>
            <th>Patient Name</th>
            <th>Age</th>
            <th>Gender</th>
            <th>Mobile</th>
            <th>Blood Group</th>
            <th>Yeshasvini</th>
            <th>Doctor</th>
            <th>Camp</th>
            <th>Camp Date</th>
            <th>Address</th>
            <th>Chief Complaint</th>
            <th>Registered At</th>

        </tr>

    `;


    patients.forEach(
        patient => {

            html += `

                <tr>

                    <td>
                        ${excelSafe(
                            patient.id
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.name
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.age
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.gender
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.mobile
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.blood
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.yeshasvini
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.doctor
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.campName
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.campDate
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.address
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.complaint
                        )}
                    </td>

                    <td>
                        ${excelSafe(
                            patient.registeredAt
                        )}
                    </td>

                </tr>

            `;

        }
    );


    html += `

        </table>

        </body>

        </html>

    `;


    const blob =
        new Blob(
            [html],
            {
                type:
                    "application/vnd.ms-excel"
            }
        );


    const url =
        URL.createObjectURL(
            blob
        );


    const link =
        document.createElement(
            "a"
        );


    link.href =
        url;


    link.download =
        "Medical_Camp_Patients_" +
        new Date()
            .toISOString()
            .slice(
                0,
                10
            ) +
        ".xls";


    document.body.appendChild(
        link
    );


    link.click();


    document.body.removeChild(
        link
    );


    URL.revokeObjectURL(
        url
    );

}


/* =========================================================
   EXCEL SAFE
========================================================= */

function excelSafe(value) {

    if (
        value === null ||
        value === undefined
    ) {

        return "";

    }


    return escapeHtml(
        String(value)
    );

}


/* =========================================================
   RESET FORM
========================================================= */

function resetRegistrationForm() {

    editingPatientId = "";

    const submitButton =
        document.querySelector(
            '#patientForm button[type="submit"]'
        );

    if (submitButton) {
        submitButton.textContent =
            "✓ Register Patient & Print";
    }

    document
        .getElementById(
            "patientForm"
        )
        .reset();


    currentPhoto =
        "";

    currentPhotoFileId =
        "";

    document
        .getElementById(
            "photoPreview"
        )
        .innerHTML =
        "No Photo";


    updateApplication();

}


function clearForm() {

    resetRegistrationForm();

}


/* =========================================================
   UTILITIES
========================================================= */

function formatDate(
    dateString
) {

    if (!dateString)
        return "";


    const date =
        new Date(
            dateString +
            "T00:00:00"
        );


    return date.toLocaleDateString(
        "en-IN",
        {

            day:
                "2-digit",

            month:
                "short",

            year:
                "numeric"

        }
    );

}


function validNumber(
    value,
    fallback
) {

    return Number.isFinite(
        value
    )
        ? value
        : fallback;

}


function escapeJs(value) {

    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/"/g, "&quot;");

}


function escapeHtml(
    value
) {

    if (
        value === null ||
        value === undefined
    ) {

        return "";

    }


    return String(value)

        .replace(
            /&/g,
            "&amp;"
        )

        .replace(
            /</g,
            "&lt;"
        )

        .replace(
            />/g,
            "&gt;"
        )

        .replace(
            /"/g,
            "&quot;"
        )

        .replace(
            /'/g,
            "&#039;"
        );

}


function showStatus(
    elementId,
    message,
    type
) {

    const element =
        document.getElementById(
            elementId
        );


    element.textContent =
        message;


    element.className =
        "status " +
        type;


    setTimeout(
        () => {

            element.className =
                "status";

        },
        4000
    );

}


/* =========================================================
   INITIALIZE
========================================================= */

async function initialize() {

    /* Local data is only a visual cache while the central state loads. */
    initializeDefaultCamp();
    renderAdminLists();
    updateApplication();
    renderPatients();
    updatePrintStyles();
    loadLetterheadSettingsToAdmin();
    updateLetterheadMarginPreview();

    try {
        await loadSharedState(true);
        await loadPatientsFromGoogleSheets(true);
    } catch (error) {
        console.error("Initial central load failed:", error);
        showStatus("formStatus", "Unable to connect to the central server. Check internet connection.", "error");
    }

    startSharedStateSync();
}


initialize();