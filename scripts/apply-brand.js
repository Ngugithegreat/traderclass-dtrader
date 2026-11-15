/*
 * Multi-site build: when BRAND_PRESET is set (Vercel project env), deep-merge
 * brands/<preset>.json over brand.config.json before the build reads it.
 * Without BRAND_PRESET the committed brand.config.json (TraderClass) is used as-is.
 */
const fs = require('fs');
const path = require('path');

const preset = (process.env.BRAND_PRESET || '').trim();
if (!preset) {
    console.log('[brand] no BRAND_PRESET, using brand.config.json');
    process.exit(0);
}
if (!/^[a-z0-9-]+$/.test(preset)) throw new Error(`[brand] invalid BRAND_PRESET "${preset}"`);

const root = path.join(__dirname, '..');
const presetFile = path.join(root, 'brands', `${preset}.json`);
if (!fs.existsSync(presetFile)) throw new Error(`[brand] missing ${presetFile}`);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
    return out;
};

const configFile = path.join(root, 'brand.config.json');
const merged = merge(JSON.parse(fs.readFileSync(configFile, 'utf8')), JSON.parse(fs.readFileSync(presetFile, 'utf8')));
fs.writeFileSync(configFile, `${JSON.stringify(merged, null, 4)}\n`);
console.log(`[brand] applied preset "${preset}" (${merged.brand_name}, app ${merged.app_id.production})`);
