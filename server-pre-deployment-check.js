#!/usr/bin/env node

/**
 * ✅ فحص شامل لملفات السيرفر قبل الرفع على Replit
 * تشغيل: node server-pre-deployment-check.js
 */

const fs = require('fs');
const path = require('path');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  reset: '\x1b[0m'
};

let checksPassed = 0;
let checksFailed = 0;

function check(title, condition, errorMsg = '') {
  if (condition) {
    console.log(`${colors.green}✅ ${title}${colors.reset}`);
    checksPassed++;
  } else {
    console.log(`${colors.red}❌ ${title}${colors.reset}`);
    if (errorMsg) console.log(`   ${colors.yellow}⚠️  ${errorMsg}${colors.reset}`);
    checksFailed++;
  }
}

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

log(colors.blue, '\n═══════════════════════════════════════════════════');
log(colors.blue, '🔍 فحص شامل لملفات السيرفر قبل الرفع على Replit');
log(colors.blue, '═══════════════════════════════════════════════════\n');

// 1. التحقق من وجود الملفات الأساسية
log(colors.yellow, '1️⃣  التحقق من الملفات الأساسية:\n');

const files = {
  'server.js': 'السيرفر الرئيسي',
  'package.json': 'المكتبات والإعدادات',
  'licenses.json': 'قاعدة بيانات الرخص'
};

for (const [file, desc] of Object.entries(files)) {
  const filePath = path.join(__dirname, file);
  const exists = fs.existsSync(filePath);
  check(`  ${desc} (${file})`, exists, exists ? '' : `الملف مفقود في ${__dirname}`);
}

// 2. التحقق من محتوى server.js
log(colors.yellow, '\n2️⃣  فحص محتوى server.js:\n');

const serverPath = path.join(__dirname, 'server.js');
if (fs.existsSync(serverPath)) {
  const serverContent = fs.readFileSync(serverPath, 'utf-8');
  
  const requiredEndpoints = [
    { name: 'GET /health', regex: /app\.get\('\/health'/ },
    { name: 'GET /api/licenses', regex: /app\.get\('\/api\/licenses'/ },
    { name: 'POST /api/licenses', regex: /app\.post\('\/api\/licenses'/ },
    { name: 'POST /api/verify-license', regex: /app\.post\('\/api\/verify-license'/ },
    { name: 'POST /api/verify-user-license', regex: /app\.post\('\/api\/verify-user-license'/ },
    { name: 'POST /api/licenses/validate', regex: /app\.post\('\/api\/licenses\/validate'/ },
    { name: 'PUT /api/licenses/:hash/deactivate', regex: /app\.put\('\/api\/licenses\/:hash\/deactivate'/ },
    { name: 'DELETE /api/licenses/:hash', regex: /app\.delete\('\/api\/licenses\/:hash'/ }
  ];

  requiredEndpoints.forEach(endpoint => {
    const exists = endpoint.regex.test(serverContent);
    check(`  ${endpoint.name}`, exists, exists ? '' : 'Endpoint مفقود');
  });

  // التحقق من الدوال المساعدة
  log(colors.yellow, '\n  الدوال المساعدة:\n');
  
  const requiredFunctions = [
    { name: 'generateLicenseKey', regex: /function generateLicenseKey/ },
    { name: 'loadLicenses', regex: /function loadLicenses/ },
    { name: 'saveLicenses', regex: /function saveLicenses/ },
    { name: 'hashLicense', regex: /function hashLicense/ }
  ];

  requiredFunctions.forEach(func => {
    const exists = func.regex.test(serverContent);
    check(`    ${func.name}`, exists, exists ? '' : 'الدالة مفقودة');
  });

  // التحقق من الـ middleware
  log(colors.yellow, '\n  Middleware المطلوب:\n');
  
  const requiredMiddleware = [
    { name: 'cors()', regex: /app\.use\(cors\(\)\)/ },
    { name: 'express.json()', regex: /app\.use\(express\.json\(\)\)/ },
    { name: 'express.static', regex: /app\.use\(express\.static/ }
  ];

  requiredMiddleware.forEach(mid => {
    const exists = mid.regex.test(serverContent);
    check(`    ${mid.name}`, exists, exists ? '' : 'Middleware مفقود');
  });

  const lines = serverContent.split('\n').length;
  check(`  عدد الأسطر (${lines} سطر)`, lines > 500, `يجب أن يكون أكثر من 500 سطر، لديك ${lines}`);

} else {
  log(colors.red, '❌ ملف server.js غير موجود!');
  checksFailed++;
}

// 3. التحقق من package.json
log(colors.yellow, '\n3️⃣  فحص package.json:\n');

const packagePath = path.join(__dirname, 'package.json');
if (fs.existsSync(packagePath)) {
  const packageContent = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
  
  check(`  اسم المشروع`, packageContent.name === 'vetcare-license-server');
  check(`  main script`, packageContent.main === 'server.js');
  check(`  start script`, packageContent.scripts.start === 'node server.js');
  
  const requiredDeps = ['express', 'cors', 'dotenv'];
  requiredDeps.forEach(dep => {
    const exists = packageContent.dependencies[dep] !== undefined;
    check(`    مكتبة ${dep}`, exists);
  });
}

// 4. التحقق من licenses.json
log(colors.yellow, '\n4️⃣  فحص licenses.json:\n');

const licensesPath = path.join(__dirname, 'licenses.json');
if (fs.existsSync(licensesPath)) {
  try {
    const licensesContent = JSON.parse(fs.readFileSync(licensesPath, 'utf-8'));
    check(`  صيغة JSON صحيحة`, Array.isArray(licensesContent));
    check(`  وجود رخص`, licensesContent.length > 0, `يوجد ${licensesContent.length} رخصة`);
    
    if (licensesContent.length > 0) {
      const firstLicense = licensesContent[0];
      const hasKey = firstLicense[1]?.key !== undefined;
      const hasExpiry = firstLicense[1]?.expirationDate !== undefined;
      const hasActive = firstLicense[1]?.isActive !== undefined;
      
      check(`  الرخصة تحتوي على key`, hasKey);
      check(`  الرخصة تحتوي على expirationDate`, hasExpiry);
      check(`  الرخصة تحتوي على isActive`, hasActive);
    }
  } catch (err) {
    log(colors.red, `  ❌ خطأ في parsing licenses.json: ${err.message}`);
    checksFailed++;
  }
}

// 5. التحقق من المجلد public
log(colors.yellow, '\n5️⃣  فحص مجلد public:\n');

const publicDir = path.join(__dirname, 'public');
const publicFiles = ['index.html', 'script.js', 'styles.css'];

if (fs.existsSync(publicDir)) {
  publicFiles.forEach(file => {
    const filePath = path.join(publicDir, file);
    const exists = fs.existsSync(filePath);
    check(`  ${file}`, exists);
  });
} else {
  log(colors.yellow, `  ⚠️  مجلد public غير موجود (غير ضروري لكن مفيد للـ Dashboard)`);
}

// النتيجة النهائية
log(colors.blue, '\n═══════════════════════════════════════════════════');
log(colors.blue, '📊 النتيجة النهائية:\n');

console.log(`${colors.green}✅ نجح: ${checksPassed}${colors.reset}`);
console.log(`${colors.red}❌ فشل: ${checksFailed}${colors.reset}`);

if (checksFailed === 0) {
  log(colors.green, '\n🎉 ممتاز! جميع الفحوصات نجحت. جاهز للرفع على Replit!\n');
  process.exit(0);
} else {
  log(colors.red, '\n⚠️  يجب إصلاح المشاكل قبل الرفع على Replit.\n');
  process.exit(1);
}
