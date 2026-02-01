const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'licenses.db');
const JSON_PATH = path.join(__dirname, 'licenses.json');

let db = null;

// ✅ Initialize database with proper error handling
const dbInit = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err.message);
    } else {
        console.log('✅ Connected to SQLite database');
    }
});

db = dbInit;

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
                migrateFromJSON().then(resolve).catch(reject);
            }
        });
    });
}

// Migrate data from licenses.json if it exists and DB is empty
function migrateFromJSON() {
    return new Promise((resolve, reject) => {
        // Check if table is empty
        db.get("SELECT count(*) as count FROM licenses", (err, row) => {
            if (err) {
                console.warn('⚠️ Error checking license count:', err.message);
                return resolve(); // Ignore error, proceed
            }

            if (row && row.count === 0 && fs.existsSync(JSON_PATH)) {
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

                    // ✅ Prepare statement (prevents multiple compilations)
                    const stmt = db.prepare(`INSERT OR REPLACE INTO licenses (
            hash, key, customerId, type, created, expirationDate, validityDays, 
            isActive, boundDeviceId, users, deviceHistory, loginHistory, usageCount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                    db.serialize(() => {
                        entries.forEach((entry) => {
                            try {
                                // Entry format in json was [hash, licenseObject]
                                let hash, license;
                                if (Array.isArray(entry)) {
                                    hash = entry[0];
                                    license = entry[1];
                                } else {
                                    // unexpected format, skip
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
                            } catch (err) {
                                console.error('❌ Error processing entry:', err.message);
                                // Continue with next entry
                            }
                        });

                        stmt.finalize((err) => {
                            if (err) {
                                console.error('❌ Error finalizing statement:', err);
                                return reject(err);
                            }
                            
                            console.log('✅ Migration completed successfully.');
                            
                            // Rename json file to prevent double migration
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

// ✅ Helper to Run SQL with Promise and error handling
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(new Error('Database not initialized'));
        }
        
        db.run(sql, params, function (err) {
            if (err) {
                console.error('❌ SQL Error:', err.message);
                reject(err);
            } else {
                resolve({ id: this.lastID, changes: this.changes });
            }
        });
    });
}

// ✅ Get single row with error handling
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(new Error('Database not initialized'));
        }
        
        db.get(sql, params, (err, result) => {
            if (err) {
                console.error('❌ SQL Error:', err.message);
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

// ✅ Get all rows with error handling
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(new Error('Database not initialized'));
        }
        
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('❌ SQL Error:', err.message);
                reject(err);
            } else {
                // Return empty array if no rows, not null
                resolve(rows || []);
            }
        });
    });
}

// ✅ Convert DB row to license object
function rowToLicense(row) {
    if (!row) return null;
    
    try {
        return {
            key: row.key,
            customerId: row.customerId,
            type: row.type,
            created: row.created,
            expirationDate: row.expirationDate,
            validityDays: row.validityDays,
            isActive: !!row.isActive,
            boundDeviceId: row.boundDeviceId,
            users: safeJsonParse(row.users, []),
            deviceHistory: safeJsonParse(row.deviceHistory, []),
            loginHistory: safeJsonParse(row.loginHistory, []),
            usageCount: row.usageCount || 0
        };
    } catch (err) {
        console.error('❌ Error converting row to license:', err);
        return null;
    }
}

// ✅ Safe JSON parse helper
function safeJsonParse(jsonStr, defaultValue = null) {
    try {
        if (!jsonStr) return defaultValue;
        return JSON.parse(jsonStr);
    } catch (err) {
        console.error('⚠️ JSON parse error:', err.message);
        return defaultValue;
    }
}

// ✅ Get database instance for graceful shutdown
function getDb() {
    return db;
}

// ✅ Close database connection
function closeDatabase() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return resolve();
        }
        
        db.close((err) => {
            if (err) {
                console.error('❌ Error closing database:', err);
                reject(err);
            } else {
                console.log('✅ Database closed successfully');
                db = null;
                resolve();
            }
        });
    });
}

module.exports = {
    db,
    getDb,
    initDatabase,
    closeDatabase,
    run,
    get,
    all,
    rowToLicense
};
