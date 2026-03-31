const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { exec } = require('child_process');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');

router.get('/', (req, res) => {
  try { res.json(db.get('settings').value()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/', (req, res) => {
  try {
    const current = db.get('settings').value();
    const updated = { ...current, ...req.body };
    db.set('settings', updated).write();
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/settings/displays
router.get('/displays', (req, res) => {
  if (os.platform() !== 'win32') {
    return res.json({
      displays: [{ id: 'auto', name: 'Auto-detect', width: null, height: null, primary: true, index: 0 }],
      method: 'fallback',
    });
  }

  const psScript = [
    '$monitors = @()',
    '$idx = 0',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$screens = [System.Windows.Forms.Screen]::AllScreens',
    'foreach ($s in $screens) {',
    '  $monitors += [PSCustomObject]@{',
    '    index      = $idx',
    '    primary    = $s.Primary.ToString().ToLower()',
    '    width      = $s.Bounds.Width',
    '    height     = $s.Bounds.Height',
    '    x          = $s.Bounds.X',
    '    y          = $s.Bounds.Y',
    '    deviceName = $s.DeviceName.Trim()',
    '    name       = if ($s.Primary) { "Primary - $($s.Bounds.Width)x$($s.Bounds.Height)" } else { "Display $($idx+1) - $($s.Bounds.Width)x$($s.Bounds.Height)" }',
    '  }',
    '  $idx++',
    '}',
    '$monitors | ConvertTo-Json -Compress',
  ].join('\r\n');

  const tmpFile = path.join(os.tmpdir(), 'vtv-displays.ps1');
  fs.writeFileSync(tmpFile, psScript, 'utf8');

  exec(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
    { timeout: 10000, windowsHide: true },
    (err, stdout) => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}

      if (err) {
        console.error('Display detection error:', err.message);
        return res.json({
          displays: [{ id: 'auto', name: 'Auto-detect (detection failed)', width: null, height: null, primary: true, index: 0 }],
          error: err.message,
          method: 'error-fallback',
        });
      }

      try {
        const raw = JSON.parse(stdout.trim());
        const arr = Array.isArray(raw) ? raw : [raw];
        const displays = [
          { id: 'auto', name: 'Auto-detect', width: null, height: null, primary: false, index: -1 },
          ...arr.map((m, i) => ({
            id:         `display-${i}`,
            name:       m.primary === 'true'
              ? `Primary - ${m.width}x${m.height} (${m.deviceName})`
              : `Display ${m.index + 1} - ${m.width}x${m.height} (${m.deviceName})`,
            width:      m.width,
            height:     m.height,
            primary:    m.primary === 'true',
            index:      m.index,
            deviceName: m.deviceName,
            x:          m.x,
            y:          m.y,
          })),
        ];
        res.json({ displays, method: 'powershell' });
      } catch (parseErr) {
        console.error('Display parse error:', parseErr.message, '| stdout:', stdout);
        res.json({
          displays: [{ id: 'auto', name: 'Auto-detect (parse failed)', width: null, height: null, primary: true, index: 0 }],
          error: parseErr.message,
          method: 'parse-error-fallback',
        });
      }
    }
  );
});

// GET /api/settings/fonts
const fontsDir = path.join(__dirname, '../../client/public/fonts');
router.get('/fonts', (req, res) => {
  try {
    if (!fs.existsSync(fontsDir)) return res.json({ fonts: [] });
    const files = fs.readdirSync(fontsDir)
      .filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f))
      .map(f => ({ filename: f, name: f.replace(/\.[^.]+$/, '') }));
    res.json({ fonts: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
