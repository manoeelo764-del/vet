const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { initDatabase, run, get, all, rowToLicense } = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper functions
function generateLicenseKey(customerId) {
  const randomSuffix = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `VET-${customerId}-${randomSuffix}`;
}

function hashLicense(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// API Routes

// Get all licenses
app.get('/api/licenses', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM licenses');
    const now = new Date();
    
    // Auto-disable expired licenses
    for (const row of rows) {
      const license = rowToLicense(row);
      const expirationDate = new Date(license.expirationDate);
      
      // If license is expired and still active, disable it automatically
      if (expirationDate < now && license.isActive) {
        console.log(`⏰ Auto-disabling expired license: ${license.key}`);
        await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [row.hash]);
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
    res.status(500).json({ error: err.message });
  }
});

// الحصول على معلومات رخصة محددة
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
      await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
      license.isActive = false;
    }
    
    res.json({
      hash,
      isExpired: expirationDate < now,
      ...license
    });
  } catch (err) {
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
      timeToResolve: '0h'
    };

    rows.forEach(row => {
      const license = rowToLicense(row);
      const expirationDate = new Date(license.expirationDate);
      const daysUntilExpiry = (expirationDate - now) / (1000 * 60 * 60 * 24);

      if (daysUntilExpiry < 0) {
        stats.expired++;
        // Also auto-disable in stats calculation
        if (license.isActive) {
          run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [row.hash]).catch(err => 
            console.error('Error auto-disabling expired license:', err)
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
    });

    stats.available = stats.total - stats.active;
    res.json(stats);
  } catch (err) {
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
    await run('UPDATE licenses SET usageCount = usageCount + 1 WHERE hash = ?', [hash]);

    res.json({
      valid: true,
      customerId: license.customerId,
      expirationDate: license.expirationDate,
      type: license.type
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// API لربط المستخدمين بالرخصة والتحكم فيهم
// إضافة مستخدمين لرخصة معينة
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

    // تحقق من عدم تكرار المستخدم
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
    res.status(500).json({ error: err.message });
  }
});

// الحصول على مستخدمي رخصة
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
    res.status(500).json({ error: err.message });
  }
});

// تعطيل/تفعيل مستخدم في رخصة
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
    res.status(500).json({ error: err.message });
  }
});

// حذف مستخدم من رخصة
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
    res.status(500).json({ error: err.message });
  }
});

// API للتحقق من بيانات المستخدم والرخصة
app.post('/api/verify-license', async (req, res) => {
  try {
    const { licenseKey, deviceId, deviceInfo } = req.body;

    if (!licenseKey || !deviceId) {
      return res.status(400).json({
        valid: false,
        reason: 'License key and device ID are required'
      });
    }

    console.log(`\n🔍 التحقق من الرخصة:`);
    console.log(`   الرخصة: ${licenseKey.substring(0, 10)}...`);
    console.log(`   الجهاز: ${deviceId}`);

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

    // 🔒 فحص جديد: التحقق من آخر استخدام
    // إذا كان آخر استخدام في المستقبل، فهذا يعني تعديل التاريخ!
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

    // التحقق من انتهاء الرخصة
    const now = new Date();
    const expirationDate = new Date(license.expirationDate);
    if (expirationDate < now) {
      console.log(`❌ الرخصة منتهية الصلاحية - جاري التعطيل التلقائي`);

      // تعطيل الرخصة تلقائياً في قاعدة البيانات عند اكتشاف انتهائها
      await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);

      return res.json({
        valid: false,
        reason: 'License expired'
      });
    }

    console.log(`✅ الرخصة سارية`);

    // التحقق من تفعيل الرخصة
    if (!license.isActive) {
      console.log(`❌ الرخصة معطلة`);
      return res.json({
        valid: false,
        reason: 'License is inactive'
      });
    }

    console.log(`✅ الرخصة مفعلة`);

    let changes = false;

    // تحديث معرّف الجهاز المرتبط بالرخصة (تعديل: جهاز واحد فقط لكل رخصة)
    if (!license.boundDeviceId) {
      license.boundDeviceId = deviceId;
      changes = true;
      console.log(`🆔 ربط الرخصة بالجهاز: ${deviceId}`);
    } else if (license.boundDeviceId !== deviceId) {
      console.log(`❌ محاولة استخدام رخصة مرتبطة بجهاز آخر: ${license.boundDeviceId} من قبل الجهاز: ${deviceId}`);
      return res.json({
        valid: false,
        reason: 'License is already bound to another device. Each license is for one device only.'
      });
    }

    // تسجيل بيانات الجهاز
    if (!license.deviceHistory) {
      license.deviceHistory = [];
    }

    // البحث عن جهاز موجود مسبقاً
    const existingDeviceIndex = license.deviceHistory.findIndex(d => d.deviceId === deviceId);

    if (existingDeviceIndex !== -1) {
      // تحديث آخر استخدام
      license.deviceHistory[existingDeviceIndex].lastUsed = now.toISOString();
      license.deviceHistory[existingDeviceIndex].usageCount = (license.deviceHistory[existingDeviceIndex].usageCount || 0) + 1;
      if (deviceInfo) {
        license.deviceHistory[existingDeviceIndex].deviceInfo = deviceInfo;
      }
      changes = true;
      console.log(`📊 تم تحديث بيانات الجهاز: ${deviceId}`);
    } else {
      // إضافة جهاز جديد
      license.deviceHistory.push({
        deviceId,
        deviceInfo: deviceInfo || {},
        firstUsed: now.toISOString(),
        lastUsed: now.toISOString(),
        usageCount: 1
      });
      changes = true;
      console.log(`🆕 تم تسجيل جهاز جديد: ${deviceId}`);
    }

    // حفظ التحديثات إذا حدث تغيير
    if (changes) {
      await run('UPDATE licenses SET boundDeviceId = ?, deviceHistory = ? WHERE hash = ?',
        [license.boundDeviceId, JSON.stringify(license.deviceHistory), hash]);
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

    // التحقق من انتهاء الرخصة
    const now = new Date();
    const expirationDate = new Date(license.expirationDate);
    if (expirationDate < now) {
      console.log(`❌ الرخصة منتهية الصلاحية للمستخدم - جاري التعطيل التلقائي`);

      // تعطيل الرخصة تلقائياً في قاعدة البيانات عند اكتشاف انتهائها
      await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);

      return res.json({
        valid: false,
        reason: 'License expired'
      });
    }

    // التحقق من تفعيل الرخصة
    if (!license.isActive) {
      return res.json({
        valid: false,
        reason: 'License is inactive'
      });
    }

    // التحقق من وجود المستخدم في الرخصة
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

    // تسجيل محاولة الدخول
    if (!license.loginHistory) {
      license.loginHistory = [];
    }
    license.loginHistory.push({
      username,
      timestamp: new Date().toISOString(),
      success: true
    });

    // الحفاظ على آخر 100 محاولة فقط
    if (license.loginHistory.length > 100) {
      license.loginHistory = license.loginHistory.slice(-100);
    }

    // Update login history and usage count
    await run('UPDATE licenses SET loginHistory = ?, usageCount = usageCount + 1 WHERE hash = ?',
      [JSON.stringify(license.loginHistory), hash]);

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
    res.status(500).json({ error: err.message });
  }
});

// Get device history for a license
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
    res.status(500).json({ error: err.message });
  }
});

// Delete license (soft delete - actually disables instead of permanently removing)
app.delete('/api/licenses/:hash', async (req, res) => {
  try {
    const { hash } = req.params;

    const row = await get('SELECT * FROM licenses WHERE hash = ?', [hash]);
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }

    // Soft delete: disable the license instead of removing it from DB
    // This maintains audit trail and prevents accidental loss of license data
    await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [hash]);
    const license = rowToLicense(row);
    license.isActive = false;

    console.log(`🔴 License disabled by administrator: ${license.key}`);
    res.json({ success: true, message: 'License disabled (soft delete)', license: { hash, ...license } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize DB and Start server
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   VetCare License Server Started       ║
    ║   Listening on port ${PORT}             ║
    ║   Dashboard: http://localhost:${PORT}   ║
    ╚════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
