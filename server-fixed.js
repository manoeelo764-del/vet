const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { initDatabase, run, get, all, rowToLicense, getDb } = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

// ⏱️ Request timeout (30 seconds)
const TIMEOUT = 30000;

// 📊 History limits (prevent unbounded growth)
const MAX_LOGIN_HISTORY = 50;
const MAX_DEVICE_HISTORY = 20;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ⏱️ Set request timeout
app.use((req, res, next) => {
  req.setTimeout(TIMEOUT);
  res.setTimeout(TIMEOUT);
  next();
});

// 📊 Memory monitoring (every minute)
setInterval(() => {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  
  console.log(`📊 Memory: ${heapUsedMB}MB / ${heapTotalMB}MB`);
  
  // Alert if memory usage exceeds 500MB
  if (memUsage.heapUsed > 500 * 1024 * 1024) {
    console.warn('⚠️ HIGH MEMORY USAGE DETECTED! (>500MB)');
  }
}, 60000);

// Helper functions
function generateLicenseKey(customerId) {
  const randomSuffix = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `VET-${customerId}-${randomSuffix}`;
}

function hashLicense(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// 🧹 Clean deviceInfo to prevent bloat
function cleanDeviceInfo(deviceInfo) {
  if (!deviceInfo) return {};
  
  // Keep only important fields, discard large objects
  return {
    os: deviceInfo.os,
    architecture: deviceInfo.architecture,
    platform: deviceInfo.platform,
    processorCount: deviceInfo.processorCount,
    totalMemory: deviceInfo.totalMemory
  };
}

// API Routes

// Get all licenses
app.get('/api/licenses', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM licenses');
    const now = new Date();
    
    // Auto-disable expired licenses (with error handling)
    for (const row of rows) {
      try {
        const license = rowToLicense(row);
        const expirationDate = new Date(license.expirationDate);
        
        if (expirationDate < now && license.isActive) {
          console.log(`⏰ Auto-disabling expired license: ${license.key}`);
          await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [row.hash]);
        }
      } catch (err) {
        console.error(`❌ Error processing license ${row.hash}:`, err.message);
        // Continue with next license instead of failing entire request
      }
    }
    
    // Re-fetch to get updated data
    const updatedRows = await all('SELECT * FROM licenses');
    const licensesList = updatedRows.map(row => {
      const license = rowToLicense(row);
      const expirationDate = new Date(license.expirationDate);
      return {
        hash: row.hash,
        isExpired: expirationDate < now,
        ...license
      };
    });
    res.json(licensesList);
  } catch (err) {
    console.error('Error in GET /api/licenses:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get specific license info
app.get('/api/licenses/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);
    const expirationDate = new Date(license.expirationDate);
    const now = new Date();
    
    // Auto-disable if expired
    if (expirationDate < now && license.isActive) {
      try {
        await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
        license.isActive = false;
      } catch (err) {
        console.error(`Error auto-disabling license ${hash}:`, err);
      }
    }
    
    res.json({
      hash,
      isExpired: expirationDate < now,
      ...license
    });
  } catch (err) {
    console.error('Error in GET /api/licenses/:hash:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get license statistics
app.get('/api/stats', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM licenses');
    const now = new Date();
    const stats = {
      total: rows.length,
      active: 0,
      inactive: 0,
      expired: 0,
      expiringIn30Days: 0,
      disabled: 0,
      timeToResolve: '0h',
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    };

    rows.forEach(row => {
      try {
        const license = rowToLicense(row);
        const expirationDate = new Date(license.expirationDate);
        const daysUntilExpiry = (expirationDate - now) / (1000 * 60 * 60 * 24);

        if (daysUntilExpiry < 0) {
          stats.expired++;
          if (license.isActive) {
            run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [row.hash]).catch(err => 
              console.error('Error auto-disabling expired license:', err.message)
            );
          }
        } else if (daysUntilExpiry <= 30) {
          stats.expiringIn30Days++;
        }

        if (license.isActive) {
          stats.active++;
        } else {
          stats.inactive++;
          stats.disabled++;
        }
      } catch (err) {
        console.error(`Error processing stats for license ${row.hash}:`, err);
      }
    });

    stats.available = stats.total - stats.active;
    res.json(stats);
  } catch (err) {
    console.error('Error in GET /api/stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new license
app.post('/api/licenses', async (req, res) => {
  try {
    const { customerId, validityDays = 365 } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required' });
    }

    const licenseKey = generateLicenseKey(customerId);
    const hash = hashLicense(licenseKey);
    const now = new Date();
    const expirationDate = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

    const license = {
      key: licenseKey,
      customerId,
      type: 'production',
      created: now.toISOString(),
      expirationDate: expirationDate.toISOString(),
      validityDays,
      boundDeviceId: null,
      deviceHistory: [],
      users: [],
      loginHistory: [],
      usageCount: 0,
      isActive: true
    };

    await run(`INSERT INTO licenses (
        hash, key, customerId, type, created, expirationDate, validityDays, 
        isActive, boundDeviceId, users, deviceHistory, loginHistory, usageCount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      hash,
      license.key,
      license.customerId,
      license.type,
      license.created,
      license.expirationDate,
      license.validityDays,
      license.isActive ? 1 : 0,
      license.boundDeviceId,
      JSON.stringify(license.users),
      JSON.stringify(license.deviceHistory),
      JSON.stringify(license.loginHistory),
      license.usageCount
    ]);

    res.status(201).json({
      success: true,
      message: 'License created successfully',
      license: { hash, ...license }
    });
  } catch (err) {
    console.error('Error in POST /api/licenses:', err);
    res.status(500).json({ error: err.message });
  }
});

// Validate license
app.post('/api/licenses/validate', async (req, res) => {
  try {
    const { licenseKey } = req.body;

    if (!licenseKey) {
      return res.status(400).json({ valid: false, reason: 'License key not provided' });
    }

    const hash = hashLicense(licenseKey);
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.json({ valid: false, reason: 'License not found' });
    }

    const license = rowToLicense(row);
    const now = new Date();
    const expirationDate = new Date(license.expirationDate);

    if (expirationDate < now) {
      return res.json({ valid: false, reason: 'License expired' });
    }

    if (!license.isActive) {
      return res.json({ valid: false, reason: 'License is inactive' });
    }

    // Increment usage count
    try {
      await run('UPDATE licenses SET usageCount = usageCount + 1 WHERE hash = ?', [hash]);
    } catch (err) {
      console.error('Error updating usage count:', err);
    }

    res.json({
      valid: true,
      customerId: license.customerId,
      expirationDate: license.expirationDate,
      type: license.type
    });
  } catch (err) {
    console.error('Error in POST /api/licenses/validate:', err);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Add users to license
app.post('/api/licenses/:hash/users', async (req, res) => {
  try {
    const { hash } = req.params;
    const { username, role = 'user' } = req.body;

    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);
    if (!license.users) license.users = [];

    if (license.users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'User already exists in this license' });
    }

    const newUser = {
      username,
      role,
      addedAt: new Date().toISOString(),
      isActive: true
    };
    license.users.push(newUser);

    await run('UPDATE licenses SET users = ? WHERE hash = ?', [JSON.stringify(license.users), hash]);

    res.status(201).json({
      success: true,
      message: 'User added to license',
      user: newUser
    });
  } catch (err) {
    console.error('Error in POST /api/licenses/:hash/users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get users for license
app.get('/api/licenses/:hash/users', async (req, res) => {
  try {
    const { hash } = req.params;
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);

    res.json({
      licenseKey: license.key,
      customerId: license.customerId,
      users: license.users || []
    });
  } catch (err) {
    console.error('Error in GET /api/licenses/:hash/users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Activate/deactivate user in license
app.put('/api/licenses/:hash/users/:username', async (req, res) => {
  try {
    const { hash, username } = req.params;
    const { isActive } = req.body;

    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);
    if (!license.users) {
      return res.status(404).json({ error: 'Users not found' });
    }

    const user = license.users.find(u => u.username === username);
    if (!user) {
      return res.status(404).json({ error: 'User not found in license' });
    }

    user.isActive = isActive;

    await run('UPDATE licenses SET users = ? WHERE hash = ?', [JSON.stringify(license.users), hash]);

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'}`,
      user
    });
  } catch (err) {
    console.error('Error in PUT /api/licenses/:hash/users/:username:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete user from license
app.delete('/api/licenses/:hash/users/:username', async (req, res) => {
  try {
    const { hash, username } = req.params;

    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);
    if (!license.users) {
      return res.status(404).json({ error: 'Users not found' });
    }

    const userIndex = license.users.findIndex(u => u.username === username);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found in license' });
    }

    license.users.splice(userIndex, 1);

    await run('UPDATE licenses SET users = ? WHERE hash = ?', [JSON.stringify(license.users), hash]);

    res.json({ success: true, message: 'User removed from license' });
  } catch (err) {
    console.error('Error in DELETE /api/licenses/:hash/users/:username:', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify license and update device info
app.post('/api/verify-license', async (req, res) => {
  try {
    const { licenseKey, deviceId, deviceInfo } = req.body;

    if (!licenseKey || !deviceId) {
      return res.status(400).json({
        valid: false,
        reason: 'License key and device ID are required'
      });
    }

    console.log(`\n🔍 التحقق من الرخصة: ${licenseKey.substring(0, 10)}...`);

    const hash = hashLicense(licenseKey);
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      console.log(`❌ الرخصة غير موجودة`);
      return res.json({
        valid: false,
        reason: 'License not found'
      });
    }

    const license = rowToLicense(row);
    console.log(`✅ الرخصة موجودة`);

    // Check for future usage (clock tamper detection)
    if (license.deviceHistory && license.deviceHistory.length > 0) {
      const lastUse = license.deviceHistory[license.deviceHistory.length - 1];
      const lastUsedDate = new Date(lastUse.lastUsed);
      const now = new Date();
      
      if (lastUsedDate > now) {
        console.log(`🚨 محاولة تجاوز! آخر استخدام: ${lastUsedDate}, الوقت الحالي: ${now}`);
        return res.json({
          valid: false,
          reason: 'TAMPER_DETECTED: System clock tampered - future usage detected',
          message: 'تم اكتشاف محاولة تعديل التاريخ'
        });
      }
    }

    // Check if license expired
    const now = new Date();
    const expirationDate = new Date(license.expirationDate);
    if (expirationDate < now) {
      console.log(`❌ الرخصة منتهية الصلاحية - جاري التعطيل التلقائي`);

      try {
        await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
      } catch (err) {
        console.error('Error auto-disabling expired license:', err);
      }

      return res.json({
        valid: false,
        reason: 'License expired'
      });
    }

    console.log(`✅ الرخصة سارية`);

    // Check if license is active
    if (!license.isActive) {
      console.log(`❌ الرخصة معطلة`);
      return res.json({
        valid: false,
        reason: 'License is inactive'
      });
    }

    console.log(`✅ الرخصة مفعلة`);

    let changes = false;

    // Bind license to device (one device per license)
    if (!license.boundDeviceId) {
      license.boundDeviceId = deviceId;
      changes = true;
      console.log(`🆔 ربط الرخصة بالجهاز: ${deviceId}`);
    } else if (license.boundDeviceId !== deviceId) {
      console.log(`❌ محاولة استخدام رخصة مرتبطة بجهاز آخر`);
      return res.json({
        valid: false,
        reason: 'License is already bound to another device. Each license is for one device only.'
      });
    }

    // Update device history (with size limits)
    if (!license.deviceHistory) {
      license.deviceHistory = [];
    }

    const existingDeviceIndex = license.deviceHistory.findIndex(d => d.deviceId === deviceId);
    const cleanedDeviceInfo = cleanDeviceInfo(deviceInfo);

    if (existingDeviceIndex !== -1) {
      // Update existing device
      license.deviceHistory[existingDeviceIndex].lastUsed = now.toISOString();
      license.deviceHistory[existingDeviceIndex].usageCount = (license.deviceHistory[existingDeviceIndex].usageCount || 0) + 1;
      if (Object.keys(cleanedDeviceInfo).length > 0) {
        license.deviceHistory[existingDeviceIndex].deviceInfo = cleanedDeviceInfo;
      }
      changes = true;
      console.log(`📊 تم تحديث بيانات الجهاز: ${deviceId}`);
    } else {
      // Add new device
      license.deviceHistory.push({
        deviceId,
        deviceInfo: cleanedDeviceInfo,
        firstUsed: now.toISOString(),
        lastUsed: now.toISOString(),
        usageCount: 1
      });
      changes = true;
      console.log(`🆕 تم تسجيل جهاز جديد: ${deviceId}`);
    }

    // Trim device history if too large
    if (license.deviceHistory.length > MAX_DEVICE_HISTORY) {
      license.deviceHistory = license.deviceHistory.slice(-MAX_DEVICE_HISTORY);
      console.log(`🧹 تم تنظيف سجل الأجهزة (الحد الأقصى: ${MAX_DEVICE_HISTORY})`);
    }

    // Save changes
    if (changes) {
      try {
        await run('UPDATE licenses SET boundDeviceId = ?, deviceHistory = ? WHERE hash = ?',
          [license.boundDeviceId, JSON.stringify(license.deviceHistory), hash]);
      } catch (err) {
        console.error('Error saving license updates:', err);
      }
    }

    return res.json({
      valid: true,
      licenseName: license.name || 'VetCare License',
      expirationDate: license.expirationDate,
      boundDeviceId: license.boundDeviceId,
      remainingDays: Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24))
    });
  } catch (error) {
    console.error('❌ License verification error:', error);
    res.status(500).json({
      valid: false,
      reason: 'Internal server error'
    });
  }
});

// Verify user license
app.post('/api/verify-user-license', async (req, res) => {
  try {
    const { username, licenseKey } = req.body;

    if (!username || !licenseKey) {
      return res.status(400).json({
        valid: false,
        reason: 'Username and license key are required'
      });
    }

    const hash = hashLicense(licenseKey);
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.json({
        valid: false,
        reason: 'License not found'
      });
    }

    const license = rowToLicense(row);

    // Check if license expired
    const now = new Date();
    const expirationDate = new Date(license.expirationDate);
    if (expirationDate < now) {
      console.log(`❌ الرخصة منتهية الصلاحية للمستخدم - جاري التعطيل التلقائي`);

      try {
        await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
      } catch (err) {
        console.error('Error auto-disabling expired license:', err);
      }

      return res.json({
        valid: false,
        reason: 'License expired'
      });
    }

    // Check if license is active
    if (!license.isActive) {
      return res.json({
        valid: false,
        reason: 'License is inactive'
      });
    }

    // Check if user assigned to license
    if (!license.users || license.users.length === 0) {
      return res.json({
        valid: false,
        reason: 'No users assigned to this license'
      });
    }

    const user = license.users.find(u => u.username === username);
    if (!user) {
      return res.json({
        valid: false,
        reason: 'User not assigned to this license'
      });
    }

    if (!user.isActive) {
      return res.json({
        valid: false,
        reason: 'User is deactivated'
      });
    }

    // Update login history with size limit
    if (!license.loginHistory) {
      license.loginHistory = [];
    }
    
    license.loginHistory.push({
      username,
      timestamp: new Date().toISOString(),
      success: true
    });

    // Keep only last MAX_LOGIN_HISTORY entries
    if (license.loginHistory.length > MAX_LOGIN_HISTORY) {
      license.loginHistory = license.loginHistory.slice(-MAX_LOGIN_HISTORY);
    }

    try {
      await run('UPDATE licenses SET loginHistory = ?, usageCount = usageCount + 1 WHERE hash = ?',
        [JSON.stringify(license.loginHistory), hash]);
    } catch (err) {
      console.error('Error updating login history:', err);
    }

    res.json({
      valid: true,
      customerId: license.customerId,
      expirationDate: license.expirationDate,
      type: license.type,
      user: {
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Error in POST /api/verify-user-license:', err);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Deactivate license
app.put('/api/licenses/:hash/deactivate', async (req, res) => {
  try {
    const { hash } = req.params;
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
    const license = rowToLicense(row);
    license.isActive = false;

    console.log(`🔴 تم تعطيل الرخصة: ${license.key}`);
    res.json({ success: true, message: 'License deactivated', license: { hash, ...license } });
  } catch (err) {
    console.error('Error in PUT /api/licenses/:hash/deactivate:', err);
    res.status(500).json({ error: err.message });
  }
});

// Activate license
app.put('/api/licenses/:hash/activate', async (req, res) => {
  try {
    const { hash } = req.params;
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    await run('UPDATE licenses SET isActive = 1 WHERE hash = ?', [hash]);
    const license = rowToLicense(row);
    license.isActive = true;

    console.log(`🟢 تم تفعيل الرخصة: ${license.key}`);
    res.json({ success: true, message: 'License activated', license: { hash, ...license } });
  } catch (err) {
    console.error('Error in PUT /api/licenses/:hash/activate:', err);
    res.status(500).json({ error: err.message });
  }
});

// Extend license validity
app.put('/api/licenses/:hash/extend', async (req, res) => {
  try {
    const { hash } = req.params;
    const { daysToAdd } = req.body;

    if (!hash || !daysToAdd || daysToAdd <= 0) {
      return res.status(400).json({ error: 'License hash and positive daysToAdd are required' });
    }

    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);
    const currentExpiry = new Date(license.expirationDate);
    const newExpiry = new Date(currentExpiry.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

    const newExpiryStr = newExpiry.toISOString();
    const newValidityDays = license.validityDays + daysToAdd;

    await run('UPDATE licenses SET expirationDate = ?, validityDays = ? WHERE hash = ?',
      [newExpiryStr, newValidityDays, hash]);

    license.expirationDate = newExpiryStr;
    license.validityDays = newValidityDays;

    console.log(`⏰ تم تمديد الرخصة: ${license.key} بـ ${daysToAdd} أيام`);
    console.log(`   تاريخ الانتهاء الجديد: ${newExpiry.toLocaleDateString('ar-SA')}`);

    res.json({
      success: true,
      message: `License extended by ${daysToAdd} days`,
      license: { hash, ...license }
    });
  } catch (err) {
    console.error('Error in PUT /api/licenses/:hash/extend:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get device history
app.get('/api/licenses/:hash/devices', async (req, res) => {
  try {
    const { hash } = req.params;
    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);

    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = rowToLicense(row);

    res.json({
      licenseKey: license.key,
      customerId: license.customerId,
      devices: license.deviceHistory || [],
      boundDeviceId: license.boundDeviceId,
      totalDevices: (license.deviceHistory || []).length
    });
  } catch (err) {
    console.error('Error in GET /api/licenses/:hash/devices:', err);
    res.status(500).json({ error: err.message });
  }
});

// Soft delete license (disable instead of removing)
app.delete('/api/licenses/:hash', async (req, res) => {
  try {
    const { hash } = req.params;

    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
    const license = rowToLicense(row);
    license.isActive = false;

    console.log(`🔴 License disabled by administrator: ${license.key}`);
    res.json({ success: true, message: 'License disabled (soft delete)', license: { hash, ...license } });
  } catch (err) {
    console.error('Error in DELETE /api/licenses/:hash:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    memory: {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024)
    }
  });
});

// Initialize DB and Start server
let server;
initDatabase().then(() => {
  server = app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   VetCare License Server Started       ║
    ║   Listening on port ${PORT}             ║
    ║   Dashboard: http://localhost:${PORT}   ║
    ║   Health: http://localhost:${PORT}/health   ║
    ╚════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// 🔒 Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('\n⏹️  Shutting down gracefully...');
  
  if (server) {
    server.close(() => {
      console.log('✅ Server closed');
    });
  }
  
  const db = getDb();
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('❌ Error closing database:', err);
      } else {
        console.log('✅ Database connection closed');
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('❌ Forced exit after 10 seconds');
    process.exit(1);
  }, 10000);
}
