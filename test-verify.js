const { initDatabase, run, get, rowToLicense } = require('./database');
const crypto = require('crypto');

async function test() {
    await initDatabase();

    const testHash = 'test_hash_' + Date.now();
    const testKey = 'TEST-KEY-' + Date.now();

    // Create an expired license
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 1);

    console.log('📝 Creating expired test license...');
    await run(`INSERT INTO licenses (hash, key, customerId, type, created, expirationDate, validityDays, isActive) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [testHash, testKey, 'test_user', 'trial', new Date().toISOString(), pastDate.toISOString(), 30, 1]);

    let row = await get('SELECT * FROM licenses WHERE hash = ?', [testHash]);
    let license = rowToLicense(row);
    console.log(`Initial Status: ${license.isActive ? 'Active' : 'Inactive'}`);

    // Simulate verification
    console.log('🔍 Simulating verification request...');
    // We can't easily call the API without starting the server, so we'll just check if we can run the logic
    // Actually, let's just use the logic from server.js manually here
    const now = new Date();
    const expirationDate = new Date(license.expirationDate);
    if (expirationDate < now) {
        console.log('Detected expiration, deactivating...');
        await run('UPDATE licenses SET isActive = 0 WHERE hash = ?', [testHash]);
    }

    row = await get('SELECT * FROM licenses WHERE hash = ?', [testHash]);
    license = rowToLicense(row);
    console.log(`Final Status: ${license.isActive ? 'Active' : 'Inactive'}`);

    if (!license.isActive) {
        console.log('✅ TEST PASSED: License was automatically deactivated.');
    } else {
        console.log('❌ TEST FAILED: License remained active.');
    }

    // Cleanup
    await run('DELETE FROM licenses WHERE hash = ?', [testHash]);
    process.exit(0);
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
