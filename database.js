const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'licenses.db');
const JSON_PATH = path.join(__dirname, 'licenses.json');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err.message);
    } else {
        // console.log('Connected to the SQLite database.'); // Verbose
    }
});

// Initialize Database Schema
function initDatabase() {
    return new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS licenses (
      hash TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      customerId TEXT,
      type TEXT,
      created TEXT,
      expirationDate TEXT,
      validityDays INTEGER,
      isActive INTEGER DEFAULT 1,
      boundDeviceId TEXT,
      users TEXT, -- JSON Array
      deviceHistory TEXT, -- JSON Array
      loginHistory TEXT, -- JSON Array
      usageCount INTEGER DEFAULT 0
    )`, (err) => {
            if (err) {
                console.error('❌ Error creating tables:', err);
                reject(err);
            } else {
                // Check if we need to migrate data
                migrateFromJSON().then(resolve);
            }
        });
    });
}

// Migrate data from licenses.json if it exists and DB is empty
function migrateFromJSON() {
    return new Promise((resolve, reject) => {
        // Check if table is empty
        db.get("SELECT count(*) as count FROM licenses", (err, row) => {
            if (err) return resolve(); // Ignore error, proceed

            if (row.count === 0 && fs.existsSync(JSON_PATH)) {
                console.log('🔄 Migrating data from licenses.json to SQLite...');
                try {
                    const fileData = fs.readFileSync(JSON_PATH, 'utf-8');
                    let entries = [];
                    try {
                        entries = JSON.parse(fileData);
                        if (!Array.isArray(entries)) {
                            // Handle case where it might be an object instead of array of entries
                            entries = Object.entries(entries);
                        }
                    } catch (e) {
                        console.error('⚠️ Failed to parse licenses.json for migration');
                        return resolve();
                    }

                    const stmt = db.prepare(`INSERT OR REPLACE INTO licenses (
            hash, key, customerId, type, created, expirationDate, validityDays, 
            isActive, boundDeviceId, users, deviceHistory, loginHistory, usageCount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                    db.serialize(() => {
                        entries.forEach((entry) => {
                            // Entry format in json was [hash, licenseObject] or just licenseObject if changed
                            let hash, license;
                            if (Array.isArray(entry)) {
                                hash = entry[0];
                                license = entry[1];
                            } else {
                                // unexpected format, try validation
                                return;
                            }

                            if (!license) return;

                            stmt.run(
                                hash,
                                license.key,
                                license.customerId,
                                license.type || 'production',
                                license.created,
                                license.expirationDate,
                                license.validityDays,
                                license.isActive ? 1 : 0,
                                license.boundDeviceId,
                                JSON.stringify(license.users || []),
                                JSON.stringify(license.deviceHistory || []),
                                JSON.stringify(license.loginHistory || []),
                                license.usageCount || 0
                            );
                        });
                        stmt.finalize(() => {
                            console.log('✅ Migration completed successfully.');
                            // Rename json file to prevent double migration if logic fails
                            try {
                                fs.renameSync(JSON_PATH, JSON_PATH + '.migrated');
                                console.log('📦 licenses.json renamed to licenses.json.migrated');
                            } catch (e) {
                                console.warn('⚠️ Could not rename licenses.json:', e.message);
                            }
                            resolve();
                        });
                    });
                } catch (error) {
                    console.error('❌ Migration failed:', error);
                    resolve(); // Resolve anyway to let server start
                }
            } else {
                resolve();
            }
        });
    });
}

// Helper to Run SQL with Promise
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                console.error('SQL Error:', err);
                reject(err);
            } else {
                resolve({ id: this.lastID, changes: this.changes });
            }
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, result) => {
            if (err) {
                console.error('SQL Error:', err);
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('SQL Error:', err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// Convert DB row to license object
function rowToLicense(row) {
    if (!row) return null;
    return {
        key: row.key,
        customerId: row.customerId,
        type: row.type,
        created: row.created,
        expirationDate: row.expirationDate,
        validityDays: row.validityDays,
        isActive: !!row.isActive,
        boundDeviceId: row.boundDeviceId,
        users: JSON.parse(row.users || '[]'),
        deviceHistory: JSON.parse(row.deviceHistory || '[]'),
        loginHistory: JSON.parse(row.loginHistory || '[]'),
        usageCount: row.usageCount
    };
}

module.exports = {
    db,
    initDatabase,
    run,
    get,
    all,
    rowToLicense
};
