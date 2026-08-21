const SHEET_ID = "1ZWz9ZLI34zgqtCzbOrpr8jQ-eOysWV1zAWjaIW84jIE";
const SHEET_NAME = "Camp Records";
const DRIVE_FOLDER_ID = "1gwpcgfwnfRtP7H9E88rvqbkU9JN3v6U4";

/*
 * Patient photos are shown directly inside the public web app.
 * Therefore Drive must allow read access through the file link.
 * Use ANYONE_WITH_LINK, not public discovery.
 * If your organisation does not permit this, set this to false
 * and use authenticated Drive access instead.
 */
const MAKE_PHOTOS_LINK_VIEWABLE = true;

const HEADERS = [
  "UHID",
  "Patient Name",
  "Age",
  "Gender",
  "Mobile",
  "Blood Group",
  "Yeshasvini",
  "Doctor",
  "Address",
  "Chief Complaint",
  "Camp ID",
  "Camp Name",
  "Camp Date",
  "Registered At",
  "Photo File ID",
  "Photo File Name"
];

const SCHEMA_VERSION = "2";
const SCHEMA_PROPERTY = "SMILES_CAMP_RECORDS_SCHEMA_VERSION";
const COUNTER_PREFIX = "SMILES_UHID_COUNTER_";


/* =========================================================
   GET
========================================================= */

function doGet() {
  return jsonResponse_({
    ok: true,
    service: "Smiles Medical Camp API",
    version: SCHEMA_VERSION
  });
}



/* =========================================================
   CENTRAL APPLICATION CONFIGURATION
========================================================= */

const CONFIG_PROPERTY = "SMILES_CENTRAL_APPLICATION_CONFIG";
const ADMIN_USERNAME_PROPERTY = "SMILES_ADMIN_USERNAME";
const ADMIN_PASSWORD_PROPERTY = "SMILES_ADMIN_PASSWORD";
const ADMIN_TOKENS_PROPERTY = "SMILES_ADMIN_SESSION_TOKENS";

function getDefaultApplicationConfiguration_() {
  return {
    version: 0,
    updatedAt: "",
    activeCampId: "",
    camps: [],
    doctors: [],
    letterhead: "",
    letterheadType: "",
    letterheadFileName: "",
    letterheadFileId: "",
    letterheadProfiles: {},
    margins: { top: 50, right: 15, bottom: 20, left: 15 }
  };
}

function adminLogin_(username, password) {
  const props = PropertiesService.getScriptProperties();
  const expectedUsername = props.getProperty(ADMIN_USERNAME_PROPERTY) || "admin";
  const expectedPassword = props.getProperty(ADMIN_PASSWORD_PROPERTY) || "admin123";

  if (String(username || "") !== expectedUsername ||
      String(password || "") !== expectedPassword) {
    return jsonResponse_({ ok: false, error: "Invalid admin username or password." });
  }

  const token = Utilities.getUuid();
  const tokens = JSON.parse(props.getProperty(ADMIN_TOKENS_PROPERTY) || "{}");
  tokens[token] = Date.now() + (12 * 60 * 60 * 1000);
  props.setProperty(ADMIN_TOKENS_PROPERTY, JSON.stringify(tokens));

  return jsonResponse_({ ok: true, token: token });
}

function requireAdmin_(token) {
  const value = String(token || "");
  if (!value) throw new Error("Admin authorization is required.");

  const props = PropertiesService.getScriptProperties();
  const tokens = JSON.parse(props.getProperty(ADMIN_TOKENS_PROPERTY) || "{}");
  const expiry = Number(tokens[value] || 0);

  if (!expiry || expiry < Date.now()) {
    delete tokens[value];
    props.setProperty(ADMIN_TOKENS_PROPERTY, JSON.stringify(tokens));
    throw new Error("Admin session has expired. Please log in again.");
  }
}

function normalizeConfiguration_(input, previous) {
  const source = input || {};
  const old = previous || getDefaultApplicationConfiguration_();

  const camps = Array.isArray(source.camps)
    ? source.camps.map(function(c, i) {
        return {
          id: String(c && c.id || ("CAMP_" + (i + 1))).trim(),
          name: String(c && c.name || "").trim(),
          date: String(c && c.date || "").trim()
        };
      }).filter(function(c) { return c.name; })
    : (old.camps || []);

  const doctors = Array.isArray(source.doctors)
    ? source.doctors.map(function(d, i) {
        return {
          id: String(d && d.id || ("DR_" + (i + 1))).trim(),
          name: String(d && d.name || "").trim(),
          campId: String(d && d.campId || "").trim()
        };
      }).filter(function(d) { return d.name; })
    : (old.doctors || []);

  const activeRequested = String(source.activeCampId || "");
  const activeCampId = camps.some(function(c) {
    return c.id === activeRequested;
  }) ? activeRequested : (camps.length ? camps[0].id : "");

  const margins = source.margins || old.margins || {};
  return {
    version: Number(old.version || 0),
    updatedAt: old.updatedAt || "",
    activeCampId: activeCampId,
    camps: camps,
    doctors: doctors,
    letterhead: String(source.letterhead || old.letterhead || ""),
    letterheadType: String(source.letterheadType || old.letterheadType || ""),
    letterheadFileName: String(source.letterheadFileName || old.letterheadFileName || ""),
    letterheadFileId: String(source.letterheadFileId || old.letterheadFileId || ""),
    letterheadProfiles: source.letterheadProfiles || old.letterheadProfiles || {},
    margins: {
      top: Number.isFinite(Number(margins.top)) ? Number(margins.top) : 50,
      right: Number.isFinite(Number(margins.right)) ? Number(margins.right) : 15,
      bottom: Number.isFinite(Number(margins.bottom)) ? Number(margins.bottom) : 20,
      left: Number.isFinite(Number(margins.left)) ? Number(margins.left) : 15
    }
  };
}

function saveLetterheadFile_(dataUrl, fileName) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid letterhead image data.");

  const mime = match[1];
  const bytes = Utilities.base64Decode(match[2]);
  const blob = Utilities.newBlob(bytes, mime, String(fileName || "letterhead"));
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const file = folder.createFile(blob);

  if (MAKE_PHOTOS_LINK_VIEWABLE) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {}
  }

  return {
    fileId: file.getId(),
    fileName: file.getName(),
    url: "https://drive.google.com/uc?export=view&id=" + encodeURIComponent(file.getId())
  };
}

function getApplicationConfiguration_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(CONFIG_PROPERTY);
  let configuration = null;

  if (raw) {
    try { configuration = JSON.parse(raw); } catch (e) {}
  }

  if (!configuration) {
    configuration = getDefaultApplicationConfiguration_();
  }

  return jsonResponse_({
    ok: true,
    configured: !!raw,
    version: Number(configuration.version || 0),
    configuration: configuration,
    camps: configuration.camps || [],
    doctors: configuration.doctors || []
  });
}

function saveApplicationConfiguration_(input) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const props = PropertiesService.getScriptProperties();
    const previousRaw = props.getProperty(CONFIG_PROPERTY);
    const previous = previousRaw
      ? JSON.parse(previousRaw)
      : getDefaultApplicationConfiguration_();

    const incoming = input || {};
    const configuration = normalizeConfiguration_(incoming, previous);

    const incomingLetterhead = String(incoming.letterhead || "");

    if (/^data:image\//i.test(incomingLetterhead)) {
      if (previous.letterheadFileId) {
        try { DriveApp.getFileById(previous.letterheadFileId).setTrashed(true); } catch (e) {}
      }

      const saved = saveLetterheadFile_(
        incomingLetterhead,
        incoming.letterheadFileName || "letterhead"
      );

      configuration.letterhead = saved.url;
      configuration.letterheadFileId = saved.fileId;
      configuration.letterheadFileName = saved.fileName;
      configuration.letterheadType = "image";
    } else if (incomingLetterhead === "") {
      if (previous.letterheadFileId) {
        try { DriveApp.getFileById(previous.letterheadFileId).setTrashed(true); } catch (e) {}
      }
      configuration.letterhead = "";
      configuration.letterheadFileId = "";
      configuration.letterheadFileName = "";
      configuration.letterheadType = "";
    }

    configuration.version = Number(previous.version || 0) + 1;
    configuration.updatedAt = new Date().toISOString();

    props.setProperty(CONFIG_PROPERTY, JSON.stringify(configuration));

    return jsonResponse_({
      ok: true,
      configured: true,
      version: configuration.version,
      configuration: configuration,
      camps: configuration.camps,
      doctors: configuration.doctors
    });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/* =========================================================
   POST ROUTER
========================================================= */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: "No request body received." });
    }

    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || "").trim();

    switch (action) {
      case "adminLogin":
        return adminLogin_(payload.username, payload.password);

      case "getApplicationConfiguration":
      case "getAppState":
      case "getLetterheadConfiguration":
        return getApplicationConfiguration_();

      case "saveApplicationConfiguration":
      case "saveAppState":
      case "saveLetterheadConfiguration":
        requireAdmin_(payload.adminToken);
        return saveApplicationConfiguration_(payload.configuration || {});

      case "savePatient":
        return savePatient_(payload.patient);

      case "getPatients":
        return getPatients_();

      case "getFileData":
        return getFileData_(payload.fileId);

      case "getNextUHID":
        return getNextUHIDPreview_(payload.campName, payload.campId);

      case "deletePatient":
        requireAdmin_(payload.adminToken);
        return deletePatient_(payload.patientId);

      default:
        return jsonResponse_({ ok: false, error: "Unsupported action: " + action });
    }
  } catch (error) {
    console.error(error);
    return jsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}


/* =========================================================
   SAVE / UPDATE PATIENT
========================================================= */

function savePatient_(input) {
  if (!input || typeof input !== "object") {
    return jsonResponse_({
      ok: false,
      error: "Patient data is missing."
    });
  }

  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const sheet = getOrCreateSheet_();
    const patient = normalizePatient_(input);


    /* ---------------------------------------------------------
       RECORD LOOKUP + SERVER-SIDE UHID

       IMPORTANT: the browser may display a UHID preview, but that
       preview is never trusted for a new registration. The server
       owns the final UHID and the ScriptLock makes concurrent
       registrations safe across multiple tablets.
    --------------------------------------------------------- */
    let existing = null;

    if (patient.id) {
      existing = findPatientRowByUHID_(sheet, patient.id);
    }

    if (!existing) {
      patient.id = generateNextUHID_(
        sheet,
        patient.campName,
        patient.campId
      );
    }

    /* ---------------------------------------------------------
       PHOTO
       A new photo is sent as a data URL. If the patient is being
       edited without selecting a new photo, keep the old Drive
       file instead of trying to upload its URL again.
    --------------------------------------------------------- */
    let photo = {
      fileId: patient.photoFileId || "",
      fileName: patient.photoFileName || ""
    };

    if (patient.photo) {
      if (!/^data:image\/[\w.+-]+;base64,/i.test(patient.photo)) {
        throw new Error(
          "Invalid patient photo data. Please upload the photo again."
        );
      }

      photo = savePhoto_(patient);
    } else if (existing) {
      const oldRow = sheet
        .getRange(existing.row, 1, 1, HEADERS.length)
        .getValues()[0];

      photo.fileId = String(oldRow[14] || "");
      photo.fileName = String(oldRow[15] || "");
    }

    /* ---------------------------------------------------------
       SERVER CANONICAL RECORD
    --------------------------------------------------------- */
    const savedAt = patient.registeredAt || new Date().toISOString();

    const row = [
      patient.id,
      patient.name,
      patient.age,
      patient.gender,
      patient.mobile,
      patient.blood,
      patient.yeshasvini,
      patient.doctor,
      patient.address,
      patient.complaint,
      patient.campId,
      patient.campName,
      patient.campDate,
      savedAt,
      photo.fileId,
      photo.fileName
    ];

    if (existing) {
      sheet.getRange(existing.row, 1, 1, HEADERS.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }

    SpreadsheetApp.flush();

    const savedPatient = buildPatientObject_(row);

    return jsonResponse_({
      ok: true,
      message: existing
        ? "Patient updated successfully."
        : "Patient saved successfully.",
      patient: savedPatient
    });

  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}


/* =========================================================
   GET ALL PATIENTS
========================================================= */

function getPatients_() {
  const sheet = getOrCreateSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse_({
      ok: true,
      patients: []
    });
  }

  const values = sheet
    .getRange(2, 1, lastRow - 1, HEADERS.length)
    .getValues();

  const patients = values
    .filter(function(row) {
      return row.some(function(value) {
        return String(value == null ? "" : value).trim() !== "";
      });
    })
    .map(buildPatientObject_);

  return jsonResponse_({
    ok: true,
    patients: patients
  });
}

function isValidUHID_(id, campName) {
  const value = String(id || "").trim();

  if (!value) {
    return false;
  }

  const prefix = campPrefix_(campName);

  const pattern = new RegExp(
    "^" + escapeRegex_(prefix) + "-\\d{4}$",
    "i"
  );

  return pattern.test(value);
}

/* =========================================================
   UHID PREVIEW

   This is display-only. It never reserves or consumes a UHID.
   The final UHID is generated by generateNextUHID_() during save.
========================================================= */

function getNextUHIDPreview_(campName, campId) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const sheet = getOrCreateSheet_();
    const prefix = campPrefix_(campName);
    const counterKey = COUNTER_PREFIX +
      safePropertyKey_(campId || campName || prefix);

    const properties = PropertiesService.getScriptProperties();
    let counter = Number(
      properties.getProperty(counterKey) || 0
    );

    if (!counter) {
      counter = findHighestCampNumber_(sheet, prefix);
    }

    let number = counter + 1;
    let candidate = makeUHID_(prefix, number);

    while (uhidExists_(sheet, candidate)) {
      number++;
      candidate = makeUHID_(prefix, number);
    }

    return jsonResponse_({
      ok: true,
      uhid: candidate
    });
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}


/* =========================================================
   DELETE PATIENT
========================================================= */

function deletePatient_(patientId) {
  const id = String(patientId || "").trim();

  if (!id) {
    return jsonResponse_({
      ok: false,
      error: "Patient UHID is missing."
    });
  }

  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const sheet = getOrCreateSheet_();
    const existing = findPatientRowByUHID_(sheet, id);

    if (!existing) {
      return jsonResponse_({
        ok: false,
        error: "Patient not found."
      });
    }

    /* Move the patient's photo to Trash as well. */
    const row = sheet
      .getRange(existing.row, 1, 1, HEADERS.length)
      .getValues()[0];

    const photoFileId = String(row[14] || "");

    if (photoFileId) {
      try {
        DriveApp
          .getFileById(photoFileId)
          .setTrashed(true);
      } catch (photoError) {
        console.warn(
          "Unable to trash patient photo:",
          photoError
        );
      }
    }

    sheet.deleteRow(existing.row);
    SpreadsheetApp.flush();

    return jsonResponse_({
      ok: true,
      message: "Patient deleted successfully.",
      patientId: id
    });

  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}


/* =========================================================
   CREATE / GET SHEET

   This function also repairs the existing Camp Records sheet.
   It creates a backup before changing an old schema.
========================================================= */

function getOrCreateSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  const properties = PropertiesService.getScriptProperties();
  const version = properties.getProperty(SCHEMA_PROPERTY);

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow === 0) {
    writeCanonicalHeaders_(sheet);
    properties.setProperty(SCHEMA_PROPERTY, SCHEMA_VERSION);
    return sheet;
  }

  const currentHeaders = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    : [];

  if (
    version !== SCHEMA_VERSION ||
    !headersAreCanonical_(currentHeaders)
  ) {
    migrateSheetToCanonical_(sheet);
    properties.setProperty(SCHEMA_PROPERTY, SCHEMA_VERSION);
  }

  return sheet;
}


/* =========================================================
   SCHEMA CHECK
========================================================= */

function headersAreCanonical_(headers) {
  if (headers.length !== HEADERS.length) {
    return false;
  }

  for (let i = 0; i < HEADERS.length; i++) {
    if (normalizeHeader_(headers[i]) !== normalizeHeader_(HEADERS[i])) {
      return false;
    }
  }

  return true;
}


function normalizeHeader_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}


/* =========================================================
   MIGRATE OLD SHEET
========================================================= */

function migrateSheetToCanonical_(sheet) {
  const ss = sheet.getParent();
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  const oldHeaders = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    : [];

  const oldValues = lastRow > 1 && lastColumn > 0
    ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues()
    : [];

  /* ---------------------------------------------------------
     Backup before migration. This is deliberately kept as a
     separate sheet so no historical data is silently destroyed.
  --------------------------------------------------------- */
  if (lastRow > 0) {
    const stamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone() || "Asia/Kolkata",
      "yyyyMMdd_HHmmss"
    );

    let backupName = SHEET_NAME + " Backup " + stamp;
    let counter = 1;

    while (ss.getSheetByName(backupName)) {
      backupName = SHEET_NAME + " Backup " + stamp + " " + counter;
      counter++;
    }

    const backup = ss.insertSheet(backupName);

    if (oldHeaders.length) {
      backup
        .getRange(1, 1, 1, oldHeaders.length)
        .setValues([oldHeaders]);
    }

    if (oldValues.length && oldHeaders.length) {
      backup
        .getRange(2, 1, oldValues.length, oldHeaders.length)
        .setValues(oldValues);
    }

    backup.setFrozenRows(1);
  }

  /* ---------------------------------------------------------
     Map old columns by header name rather than by position.
     This is what fixes the currently shifted Camp Records data.
  --------------------------------------------------------- */
  const indexMap = buildHeaderIndexMap_(oldHeaders);

  const migrated = oldValues.map(function(row) {
    return [
      valueFromAliases_(row, indexMap, [
        "uhid", "patientid", "patient id", "id"
      ]),

      valueFromAliases_(row, indexMap, [
        "patientname", "patient name", "name"
      ]),

      valueFromAliases_(row, indexMap, ["age"]),

      valueFromAliases_(row, indexMap, ["gender", "sex"]),

      valueFromAliases_(row, indexMap, [
        "mobile", "phone", "contact", "contactnumber"
      ]),

      valueFromAliases_(row, indexMap, [
        "bloodgroup", "blood group", "blood"
      ]),

      valueFromAliases_(row, indexMap, ["yeshasvini"]),

      valueFromAliases_(row, indexMap, [
        "doctor", "doctorname", "doctor name", "consulteddoctor"
      ]),

      valueFromAliases_(row, indexMap, [
        "address", "patientaddress"
      ]),

      valueFromAliases_(row, indexMap, [
        "chiefcomplaint", "chief complaint", "complaint", "reasonforvisit"
      ]),

      valueFromAliases_(row, indexMap, [
        "campid", "camp id"
      ]),

      valueFromAliases_(row, indexMap, [
        "campname", "camp name", "camp"
      ]),

      valueFromAliases_(row, indexMap, [
        "campdate", "camp date", "date"
      ]),

      valueFromAliases_(row, indexMap, [
        "registeredat", "registered at", "timestamp", "registrationdate", "date time"
      ]),

      valueFromAliases_(row, indexMap, [
        "photofileid", "photo file id", "photoid", "photo id"
      ]),

      valueFromAliases_(row, indexMap, [
        "photofilename", "photo file name", "photofilename", "photo file"
      ])
    ];
  });

  /* Replace the active sheet with the canonical 16-column schema. */
  sheet.clearContents();
  sheet.clearFormats();

  writeCanonicalHeaders_(sheet);

  if (migrated.length) {
    sheet
      .getRange(2, 1, migrated.length, HEADERS.length)
      .setValues(migrated);
  }

  assignMissingUHIDs_(sheet);
}


function buildHeaderIndexMap_(headers) {
  const map = {};

  headers.forEach(function(header, index) {
    const key = normalizeHeader_(header);
    if (key && map[key] === undefined) {
      map[key] = index;
    }
  });

  return map;
}


function valueFromAliases_(row, indexMap, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const key = normalizeHeader_(aliases[i]);
    const index = indexMap[key];

    if (index !== undefined) {
      return row[index] == null ? "" : row[index];
    }
  }

  return "";
}


function writeCanonicalHeaders_(sheet) {
  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS]);

  sheet.setFrozenRows(1);

  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setFontWeight("bold");
}


/* =========================================================
   UHID GENERATION

   The counter is protected by ScriptLock in savePatient_.
   Each camp gets its own counter.
========================================================= */

function generateNextUHID_(sheet, campName, campId) {
  const prefix = campPrefix_(campName);

  const counterKey = COUNTER_PREFIX +
    safePropertyKey_(campId || campName || prefix);

  const properties = PropertiesService.getScriptProperties();
  let counter = Number(
    properties.getProperty(counterKey) || 0
  );

  /*
   * First run for an existing camp: inspect the sheet once so
   * the counter starts after the highest existing UHID.
   */
  if (!counter) {
    counter = findHighestCampNumber_(sheet, prefix);
  }

  let nextNumber = counter + 1;
  let candidate = makeUHID_(prefix, nextNumber);

  /* Defensive collision check. */
  while (uhidExists_(sheet, candidate)) {
    nextNumber++;
    candidate = makeUHID_(prefix, nextNumber);
  }

  properties.setProperty(
    counterKey,
    String(nextNumber)
  );

  return candidate;
}


function findHighestCampNumber_(sheet, prefix) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return 0;
  }

  const ids = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues();

  const expression = new RegExp(
    "^" + escapeRegex_(prefix) + "-(\\d+)$",
    "i"
  );

  let highest = 0;

  ids.forEach(function(row) {
    const id = String(row[0] || "").trim();
    const match = id.match(expression);

    if (match) {
      highest = Math.max(
        highest,
        Number(match[1]) || 0
      );
    }
  });

  return highest;
}


function uhidExists_(sheet, uhid) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return false;
  }

  const ids = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues();

  const target = String(uhid).toUpperCase();

  return ids.some(function(row) {
    return String(row[0] || "")
      .trim()
      .toUpperCase() === target;
  });
}


function makeUHID_(prefix, number) {
  return prefix + "-" +
    String(number).padStart(4, "0");
}


function campPrefix_(name) {
  let prefix = String(name || "CAMP")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!prefix) {
    prefix = "CAMP";
  }

  return prefix.substring(0, 18);
}


function safePropertyKey_(value) {
  return String(value || "CAMP")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .substring(0, 60);
}


function escapeRegex_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/* =========================================================
   MIGRATION: FILL MISSING UHIDs
========================================================= */

function assignMissingUHIDs_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return;
  }

  const rows = sheet
    .getRange(2, 1, lastRow - 1, HEADERS.length)
    .getValues();

  const used = {};

  rows.forEach(function(row) {
    const id = String(row[0] || "").trim();
    if (id) {
      used[id.toUpperCase()] = true;
    }
  });

  const counters = {};

  rows.forEach(function(row) {
    const currentId = String(row[0] || "").trim();

    if (currentId) {
      return;
    }

    const prefix = campPrefix_(row[11]);
    let number = counters[prefix] || findHighestCampNumber_(sheet, prefix);

    do {
      number++;
    } while (used[makeUHID_(prefix, number).toUpperCase()]);

    const newId = makeUHID_(prefix, number);

    row[0] = newId;
    used[newId.toUpperCase()] = true;
    counters[prefix] = number;
  });

  sheet
    .getRange(2, 1, rows.length, HEADERS.length)
    .setValues(rows);
}


/* =========================================================
   FIND PATIENT ROW
========================================================= */

function findPatientRowByUHID_(sheet, uhid) {
  const id = String(uhid || "").trim();

  if (!id || sheet.getLastRow() <= 1) {
    return null;
  }

  const ids = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getValues();

  for (let i = 0; i < ids.length; i++) {
    if (
      String(ids[i][0] || "")
        .trim()
        .toUpperCase() === id.toUpperCase()
    ) {
      return {
        row: i + 2
      };
    }
  }

  return null;
}


/* =========================================================
   NORMALIZE PATIENT
========================================================= */

function normalizePatient_(input) {
  return {
    id: String(input.id || "").trim(),
    name: String(input.name || "").trim(),
    age: input.age == null ? "" : input.age,
    gender: String(input.gender || "").trim(),
    mobile: String(input.mobile || "").trim(),
    blood: String(input.blood || "").trim(),
    yeshasvini: String(input.yeshasvini || "").trim(),
    doctor: String(input.doctor || "").trim(),
    address: String(input.address || "").trim(),
    complaint: String(input.complaint || "").trim(),
    photo: String(input.photo || ""),
    campId: String(input.campId || "").trim(),
    campName: String(input.campName || "").trim(),
    campDate: input.campDate || "",
    registeredAt: input.registeredAt || new Date().toISOString(),
    photoFileId: String(input.photoFileId || "").trim(),
    photoFileName: String(input.photoFileName || "").trim()
  };
}


/* =========================================================
   BUILD CLIENT PATIENT OBJECT
========================================================= */

function buildPatientObject_(row) {
  const photoFileId = String(row[14] || "").trim();

  return {
    id: String(row[0] || ""),
    name: String(row[1] || ""),
    age: row[2] == null ? "" : row[2],
    gender: String(row[3] || ""),
    mobile: String(row[4] || ""),
    blood: String(row[5] || ""),
    yeshasvini: String(row[6] || ""),
    doctor: String(row[7] || ""),
    address: String(row[8] || ""),
    complaint: String(row[9] || ""),
    campId: String(row[10] || ""),
    campName: String(row[11] || ""),
    campDate: row[12] || "",
    registeredAt: row[13] || "",
    photoFileId: photoFileId,
    photoFileName: String(row[15] || ""),
    photo: photoFileId
      ? "https://drive.google.com/uc?export=view&id=" +
        encodeURIComponent(photoFileId)
      : ""
  };
}


/* =========================================================
   SAVE PHOTO TO DRIVE
========================================================= */

function savePhoto_(patient) {
  if (!patient.photo || !DRIVE_FOLDER_ID) {
    return {
      fileId: "",
      fileName: ""
    };
  }

  const match = String(patient.photo).match(
    /^data:(image\/[\w.+-]+);base64,(.+)$/
  );

  if (!match) {
    throw new Error("Invalid patient photo data.");
  }

  const mimeType = match[1];
  const bytes = Utilities.base64Decode(match[2]);

  let extension = mimeType
    .split("/")
    .pop()
    .toLowerCase();

  if (extension === "jpeg") {
    extension = "jpg";
  }

  const fileName =
    String(patient.id) + "." + extension;

  const folder = DriveApp.getFolderById(
    DRIVE_FOLDER_ID
  );

  /* Remove a previous version with the same UHID. */
  const existing = folder.getFilesByName(fileName);

  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  const blob = Utilities.newBlob(
    bytes,
    mimeType,
    fileName
  );

  const file = folder.createFile(blob);

  if (MAKE_PHOTOS_LINK_VIEWABLE) {
    try {
      file.setSharing(
        DriveApp.Access.ANYONE_WITH_LINK,
        DriveApp.Permission.VIEW
      );
    } catch (sharingError) {
      console.warn(
        "Drive link sharing could not be enabled:",
        sharingError
      );
    }
  }

  return {
    fileId: file.getId(),
    fileName: file.getName()
  };
}


/* =========================================================
   GET DRIVE FILE AS DATA URL FOR PRINTING
   Browser print/PDF must not depend on a cross-origin Drive
   image still being available when window.print() snapshots
   the page. Convert the centrally stored file to a data URL
   on the server, then print the exact bytes.
========================================================= */

function getFileData_(fileId) {
  const id = String(fileId || "").trim();

  if (!id) {
    return jsonResponse_({ ok: false, error: "File ID is required." });
  }

  try {
    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    const mimeType = blob.getContentType() || "application/octet-stream";

    return jsonResponse_({
      ok: true,
      fileId: id,
      fileName: file.getName(),
      mimeType: mimeType,
      dataUrl: "data:" + mimeType + ";base64," + Utilities.base64Encode(bytes)
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: "Unable to read the stored file for printing: " + error.message
    });
  }
}


/* =========================================================
   JSON RESPONSE
========================================================= */

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}