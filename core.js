/** Pure matching and settings utilities. No DOM or SillyTavern globals required. */

const own = (value, key) => value !== null && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const LEGACY_DIALOGUE_PROMPT = '# Dialogue Format\n- Output all dialogue as: `Speaker Name | "Dialogue"`\n- Add a blank line after each line.';
const PREVIOUS_DIALOGUE_PROMPT_A = '# Dialogue Format\n\n- Output all dialogue as: `Speaker Name | "Dialogue"`\n- Unnamed background, incidental, or passing characters: `"Dialogue"`; Only use names for established, story-relevant, or meaningful recurring/supporting characters.\n- Add a blank line after each line.';
const PREVIOUS_DIALOGUE_PROMPT_B = '# Dialogue Format\n\n- Format: `Speaker Name | "Dialogue"`\n- Non-Korean speech = preserve the spoken language and append a Korean translation: `Speaker Name | "Original" (Korean translation)`\n- Keep original-language dialogue natural to the character\'s linguistic/cultural background, not literal Korean phrasing.\n- Unnamed background, incidental, or passing characters: `"Dialogue"`; Only use names for established, story-relevant, or meaningful recurring/supporting characters.\n- Add a blank line after each line.';
export const DEFAULT_DIALOGUE_PROMPT = [
    '# Dialogue Format',
    '- Default (KR/EN/ETC): `Name | "Dialogue"`',
    '- JP: `Surname | 「Dialogue」`',
    '- Unnamed background, incidental, or passing characters: `"Dialogue"`; Only use names for established, story-relevant, or meaningful recurring/supporting characters.',
    '- Add a blank line after each line.',
].join('\n');
export const DEFAULT_DIALOGUE_PROMPT_B = [
    '# Dialogue Format',
    '- Default (KR/EN/ETC): `Name | "Dialogue"`',
    '- JP: `Surname | 「Dialogue」`',
    '- Non-Korean dialogue must remain in the spoken language, followed by a Korean translation: `Name | "Original" (Korean translation)`',
    "- Keep non-Korean dialogue natural to the character's linguistic/cultural background, not literal Korean phrasing.",
    '- Unnamed incidental/background characters: dialogue only; name only established, relevant, or recurring/supporting characters.',
    '- Leave one blank line after each line.',
].join('\n');

function migrateShippedPrompt(value, previous, current) {
    return value === previous ? current : value;
}
export const DEFAULT_SETTINGS = Object.freeze({
    dialoguePromptEnabled: false,
    dialoguePrompt: DEFAULT_DIALOGUE_PROMPT,
    dialoguePromptPreset: 'A',
    dialoguePrompts: Object.freeze({ A: DEFAULT_DIALOGUE_PROMPT, B: DEFAULT_DIALOGUE_PROMPT_B }),
    version: 1,
    enabled: true,
    renderDepth: 0,
    namePosition: 'none',
    fontMode: 'theme',
    nameFont: 'pretendard',
    dialogueFont: 'pretendard',
    nameFontSize: 12,
    dialogueFontSize: 15,
    quoteColorEnabled: false,
    quoteColor: '#808080',
    emphasisColorEnabled: false,
    emphasisColor: '#808080',
    parenColorEnabled: false,
    parenColor: '#808080',
    quoteStyle: 'theme',
    design: 'minimal',
    bubbleColorEnabled: false,
    bubbleColor: '#808080',
    bubbleOpacity: 7,
    shape: 'circle',
    size: 48,
    borderEnabled: false,
    borderColor: '#808080',
    borderWidth: 1,
    profiles: Object.freeze([]),
});

export function normalizeName(text) {
    if (typeof text !== 'string') return '';
    return text.normalize('NFKC').trim()
        .replace(/^[\s*_`]+|[\s*_`]+$/gu, '').trim();
}

const QUOTES = new Map([
    ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'],
    ['「', '」'], ['『', '』'], ['«', '»'],
]);

/**
 * Parse one complete dialogue line. Speech excludes its enclosing quotes;
 * translation preserves parentheses and other trailing text.
 */
export function dialoguePrefix(text) {
    return /^\s*(?:\[([^\]\r\n]+)\]\s*|([^|｜:：\r\n]+?)\s*[|｜:：]\s*)/u.exec(text);
}

export function parseDialogueLine(text) {
    if (typeof text !== 'string' || /[\r\n\u2028\u2029<>]/u.test(text)) return null;
    const line = text.trim();
    if (!line || /```|~~~/u.test(line)) return null;
    const prefix = dialoguePrefix(line);
    if (!prefix) return null;
    const name = normalizeName(prefix[1] ?? prefix[2]);
    if (!name || name.length > 100 || /[|｜{}\[\]=;\\]/u.test(name)) return null;
    if (/^(?:const|let|var|return|function|class|import|export|throw|if|for|while)\b/u.test(name)) return null;
    if (/^[#>]|^[ \t]*[-+]\s/u.test(name)) return null;

    const body = line.slice(prefix[0].length).trim();
    const quoteOpen = body[0];
    const quoteClose = QUOTES.get(quoteOpen);
    if (!quoteClose) return null;
    let escaped = false;
    let closeAt = -1;
    for (let i = 1; i < body.length; i += 1) {
        const char = body[i];
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === quoteClose) {
            // A curly/straight apostrophe inside a word is not an ending quote.
            const apostrophe = quoteClose === "'" || quoteClose === '’';
            if (apostrophe && /[\p{L}\p{N}]/u.test(body[i - 1])
                && /[\p{L}\p{N}]/u.test(body[i + 1] || '')) continue;
            closeAt = i;
            break;
        }
    }
    if (closeAt < 0) return null;
    const speech = body.slice(1, closeAt);
    const translation = body.slice(closeAt + 1).trim();
    if (!speech.trim()) return null;
    // Do not consume another speaker or a second standalone quoted utterance.
    if (/[|｜]/u.test(translation) || QUOTES.has(translation[0])) return null;
    return { name, speech, translation, quoteOpen, quoteClose };
}

/** Name lookups run once per rendered line, so the scan is replaced by a prebuilt index. */
let speakerCache = null;

function nameIndex(entries) {
    const index = new Map();
    for (const profile of Array.isArray(entries) ? entries : []) {
        if (!record(profile)) continue;
        const aliases = own(profile, 'aliases');
        const names = [own(profile, 'name'), ...(Array.isArray(aliases) ? aliases : [])];
        // A profile listing one name twice must not make itself ambiguous.
        const seen = new Set();
        for (const name of names) {
            const key = normalizeName(name);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const bucket = index.get(key);
            if (bucket) bucket.push(profile);
            else index.set(key, [profile]);
        }
    }
    return index;
}

/** Rebuilt only when a save replaces the profile arrays; sanitizing always returns new ones. */
function speakerIndex(scopedProfiles, profiles) {
    if (speakerCache?.scoped === scopedProfiles && speakerCache.global === profiles) return speakerCache;
    speakerCache = {
        scoped: scopedProfiles,
        global: profiles,
        scopedIndex: nameIndex(scopedProfiles),
        globalIndex: nameIndex(profiles),
    };
    return speakerCache;
}

/** Only explicitly registered people match. Bot-specific names take priority. */
export function resolveSpeaker(name, { scopedProfiles = [], profiles = [] } = {}) {
    const target = normalizeName(name);
    if (!target) return null;
    const index = speakerIndex(scopedProfiles, profiles);
    for (const bucket of [index.scopedIndex.get(target), index.globalIndex.get(target)]) {
        if (!bucket) continue;
        return bucket.length > 1 ? { kind: 'ambiguous' } : { kind: 'profile', profile: bucket[0] };
    }
    return null;
}

/** One editor field; keep the v1 name/aliases shape internally for lossless upgrades. */
export function parseNames(value) {
    return [...new Set(String(value ?? '').split(/[,，\n]/u).map(normalizeName).filter(Boolean))];
}

function boundedNumber(value, min, max, fallback) {
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    if (typeof value === 'string' && !value.trim()) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function isServerImage(value) {
    return typeof value==='string' && value.length<2048 && /^(?:\/(?:[a-zA-Z0-9_-]+\/)*|)user\/images\/speaker-portraits\/sp-[a-zA-Z0-9_-]+\.(?:png|jpeg|webp|gif)$/.test(value);
}

/** Normalize only same-origin web paths, never filesystem paths or external hosts. */
export function normalizeServerImage(value,baseURL){
    if(typeof value!=='string')return '';
    let path=value.startsWith('./')?value.slice(2):value;
    if(/^https?:\/\//i.test(path)){
        if(!baseURL)return '';
        try{const url=new URL(path),base=new URL(baseURL);
            if(url.origin!==base.origin||url.username||url.password||url.search||url.hash)return '';
            // Reject traversal before URL canonicalization can hide it.
            if(/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f)/i.test(path))return '';
            path=url.pathname;
        }catch{return '';}
    }
    return isServerImage(path)?path:'';
}

export function safePhotoSource(value){
    if(!record(value)||!['avatar','persona'].includes(own(value,'type')))return null;
    const file=own(value,'file');
    if(typeof file!=='string'||!file.trim()||file.length>512||/[\\/\u0000-\u001f]/u.test(file)||['.','..'].includes(file))return null;
    return {type:own(value,'type'),file};
}

function safeImage(value) {
    if(isServerImage(value))return value;
    if (typeof value !== 'string' || value.length > 8_000_000) return '';
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
    if (!match || match[2].length % 4 !== 0) return '';
    return `data:image/${match[1].toLowerCase()};base64,${match[2]}`;
}

/** Rebuild an allowlisted object; imported keys and inherited properties are never copied. */
export function sanitizeSettings(input) {
    const source = record(input) ? input : {};
    const boolean = (key, fallback) => typeof own(source, key) === 'boolean' ? own(source, key) : fallback;
    const hexColor = (key, fallback = '#808080') => typeof own(source, key) === 'string'
        && /^#[0-9a-f]{6}$/i.test(own(source, key)) ? own(source, key) : fallback;
    const design = own(source, 'design');
    const shape = own(source, 'shape');
    const storedPrompt = own(source, 'dialoguePrompt');
    const legacyPrompt = typeof storedPrompt === 'string'
        ? (storedPrompt === LEGACY_DIALOGUE_PROMPT
            ? DEFAULT_DIALOGUE_PROMPT
            : migrateShippedPrompt(storedPrompt.slice(0, 8000), PREVIOUS_DIALOGUE_PROMPT_A, DEFAULT_DIALOGUE_PROMPT))
        : DEFAULT_DIALOGUE_PROMPT;
    const slots = own(source, 'dialoguePrompts');
    const dialoguePromptPreset = own(source, 'dialoguePromptPreset') === 'B' ? 'B' : 'A';
    const dialoguePrompts = {
        A: typeof own(slots, 'A') === 'string'
            ? migrateShippedPrompt(own(slots, 'A').slice(0, 8000), PREVIOUS_DIALOGUE_PROMPT_A, DEFAULT_DIALOGUE_PROMPT)
            : legacyPrompt,
        B: typeof own(slots, 'B') === 'string'
            ? migrateShippedPrompt(own(slots, 'B').slice(0, 8000), PREVIOUS_DIALOGUE_PROMPT_B, DEFAULT_DIALOGUE_PROMPT_B)
            : DEFAULT_DIALOGUE_PROMPT_B,
    };
    const settings = {
        dialoguePromptPreset,
        dialoguePrompts,
        dialoguePromptEnabled: boolean('dialoguePromptEnabled', false),
        dialoguePrompt: dialoguePrompts[dialoguePromptPreset],
        version: 1,
        enabled: boolean('enabled', true),
        renderDepth: Math.floor(boundedNumber(own(source, 'renderDepth'), 0, Number.MAX_SAFE_INTEGER, 0)),
        namePosition: own(source, 'namePosition') === 'above' && own(source, 'showName') !== false ? 'above' : 'none',
        fontMode: own(source,'fontMode') === 'custom' ? 'custom' : 'theme',
        nameFont: ['theme','pretendard','ridi','gowun','paperlogy','cafe24'].includes(own(source,'nameFont')) ? own(source,'nameFont') : 'pretendard',
        dialogueFont: ['theme','pretendard','ridi','gowun','paperlogy','cafe24'].includes(own(source,'dialogueFont')) ? own(source,'dialogueFont') : 'pretendard',
        nameFontSize: Math.round(boundedNumber(own(source,'nameFontSize'),10,28,12)),
        dialogueFontSize: Math.round(boundedNumber(own(source,'dialogueFontSize'),12,36,15)),
        quoteColorEnabled: boolean('quoteColorEnabled',false),
        quoteColor: hexColor('quoteColor'),
        emphasisColorEnabled: boolean('emphasisColorEnabled',false),
        emphasisColor: hexColor('emphasisColor'),
        parenColorEnabled: boolean('parenColorEnabled',false),
        parenColor: hexColor('parenColor'),
        quoteStyle: own(source, 'quoteStyle') === 'override' ? 'override' : 'theme',
        design: ['minimal', 'bubble'].includes(design) ? design : 'minimal',
        bubbleColorEnabled: boolean('bubbleColorEnabled', false),
        bubbleColor: hexColor('bubbleColor'),
        bubbleOpacity: Math.round(boundedNumber(own(source,'bubbleOpacity'),0,100,7)),
        shape: ['circle', 'rounded'].includes(shape) ? shape : 'circle',
        size: Math.round(boundedNumber(own(source, 'size'), 32, 88, 48)),
        borderEnabled: boolean('borderEnabled', false),
        borderColor: hexColor('borderColor'),
        borderWidth: Math.round(boundedNumber(own(source, 'borderWidth'), 0, 6, 1)),
        profiles: [],
    };
    const entries = own(source, 'profiles');
    if (!Array.isArray(entries)) return settings;
    const ids = new Set();
    for (const entry of entries.slice(0, 150)) {
        if (!record(entry)) continue;
        const name = normalizeName(own(entry, 'name')).slice(0, 100);
        if (!name) continue;
        const rawId = own(entry, 'id');
        const baseId = typeof rawId === 'string' && /^[\w-]{1,100}$/u.test(rawId)
            ? rawId : `profile-${settings.profiles.length + 1}`;
        let id = baseId;
        let suffix = 2;
        while (ids.has(id)) id = `${baseId}-${suffix++}`;
        ids.add(id);
        const rawAliases = own(entry, 'aliases');
        const aliases = Array.isArray(rawAliases)
            ? [...new Set(rawAliases.slice(0, 32).map(alias => normalizeName(alias).slice(0, 100)))]
                .filter(alias => alias && alias !== name) : [];
        settings.profiles.push({
            id,
            name,
            aliases,
            enabled: own(entry, 'enabled') !== false,
            hideWhenMasked: own(entry, 'hideWhenMasked') === true,
            image: safeImage(own(entry, 'image')),
            zoom: boundedNumber(own(entry, 'zoom'), 1, 3, 1.25),
            x: boundedNumber(own(entry, 'x'), 0, 100, 50),
            y: boundedNumber(own(entry, 'y'), 0, 100, 35),
        });
        const photoSource=safePhotoSource(own(entry,'photoSource'));
        if(photoSource){settings.profiles.at(-1).photoSource=photoSource;settings.profiles.at(-1).image='';}
    }
    return settings;
}
