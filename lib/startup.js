import readline from 'readline';

export async function promptSetup() {
    // ---- Environment Variables check (Railway සඳහා) ----
    const envUsePairing = process.env.USE_PAIRING_CODE;
    const envPairingNumber = process.env.PAIRING_NUMBER;
    const envAllowedUsers = process.env.ALLOWED_USERS;

    // Environment variables තිබ්බොත්, prompt නැතුව ඒවා use කරන්න
    if (envUsePairing !== undefined || envAllowedUsers !== undefined) {
        console.log('📦 Loading configuration from environment variables...');
        return {
            usePairingCode: envUsePairing === 'true' || envUsePairing === '1',
            pairingNumber: envPairingNumber ? envPairingNumber.replace(/[^0-9]/g, '') : null,
            allowedUsers: envAllowedUsers
                ? envAllowedUsers.split(',').map(s => s.replace(/[^0-9]/g, '')).filter(Boolean)
                : []
        };
    }

    // ---- Fallback: Interactive prompt (local terminal සඳහා) ----
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

    const line = '─'.repeat(55);

    console.log(`\n\x1b[36m${line}\x1b[0m`);
    console.log(`\x1b[1m🤖  Bot Startup Setup\x1b[0m`);
    console.log(`\x1b[36m${line}\x1b[0m\n`);

    console.log('  1) 🔑 Pairing Code');
    console.log('  2) 📷 QR Code\n');
    const choice = await ask('  Choose [1/2]: ');
    const usePairingCode = choice.trim() === '1';

    let pairingNumber = null;
    if (usePairingCode) {
        let input = await ask('\n  📞 Enter your WhatsApp number (with country code): ');
        pairingNumber = input.replace(/[^0-9]/g, '');

        while (!pairingNumber || pairingNumber.length < 7) {
            console.log('  ⚠️  Invalid number. Try again.');
            input = await ask('  📞 Enter your WhatsApp number: ');
            pairingNumber = input.replace(/[^0-9]/g, '');
        }
    }

    console.log('\n  👥 Enter allowed user numbers');
    console.log('     (separate multiple numbers with commas or spaces)');
    console.log('     ⏎ Just press Enter to allow ONLY YOU (owner)\n');
    const allowedInput = await ask('  📋 Allowed users: ');

    const allowedUsers = allowedInput
        .split(/[\s,]+/)
        .map((s) => s.replace(/[^0-9]/g, ''))
        .filter(Boolean);

    rl.close();

    console.log(`\n\x1b[32m${line}\x1b[0m`);
    console.log(`  ✅ Setup complete`);
    console.log(`  🔑 Method        : ${usePairingCode ? 'Pairing Code' : 'QR Code'}`);
    if (pairingNumber) {
        console.log(`  📞 Your Number   : ${pairingNumber}`);
    }
    if (allowedUsers.length === 0) {
        console.log(`  👥 Allowed Users : \x1b[33mOwner only 🔒\x1b[0m`);
    } else {
        console.log(`  👥 Allowed Users : ${allowedUsers.length} (+ owner)`);
        allowedUsers.forEach((u, i) => console.log(`       ${i + 1}. ${u}`));
    }
    console.log(`\x1b[32m${line}\x1b[0m\n`);

    return { usePairingCode, pairingNumber, allowedUsers };
}