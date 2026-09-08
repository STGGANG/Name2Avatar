/** Pure matching and settings utilities. No DOM or SillyTavern globals required. */

const own = (value, key) => value !== null && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const DEFAULT_DIALOGUE_PROMPT = '# Dialogue Format\n- Output all dialogue as: `Speaker Name | "Dialogue"`\n- Add a blank line after each line.';
export const DEFAULT_SETTINGS = Object.freeze({
    dialoguePromptEnabled: false,
    dialoguePrompt: DEFAULT_DIALOGUE_PROMPT,
    version: 1,
    enabled: true,
    namePosition: 'none',
    fontMode: 'theme',
    nameFont: 'pretendard',
    dialogueFont: 'pretendard',
    nameFontSize: 12,
    dialogueFontSize: 15,
    quoteColorEnabled: false,
    quoteColor: '#808080',
    quoteStyle: 'theme',
    design: 'minimal',
    shape: 'circle',
    size: 48,
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

/** Only explicitly registered people match. Bot-specific names take priority. */
export function resolveSpeaker(name, { scopedProfiles = [], profiles = [] } = {}) {
    const target = normalizeName(name);
    if (!target) return null;
    const matchingProfiles = entries => (Array.isArray(entries) ? entries : []).filter(profile => {
        if (!record(profile)) return false;
        if (normalizeName(own(profile, 'name')) === target) return true;
        const aliases = own(profile, 'aliases');
        return Array.isArray(aliases) && aliases.some(alias => normalizeName(alias) === target);
    });
    const scoped = matchingProfiles(scopedProfiles);
    if (scoped.length > 1) return { kind: 'ambiguous' };
    if (scoped.length === 1) return { kind: 'profile', profile: scoped[0] };
    const custom = matchingProfiles(profiles);
    if (custom.length > 1) return { kind: 'ambiguous' };
    if (custom.length === 1) return { kind: 'profile', profile: custom[0] };

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
    return typeof value==='string' && value.length<2048 && /^(?:\/(?:[a-zA-Z0-9_-]+\/)*|)user\/images\/speaker-portraits\/sp-[a-zA-Z0-9_-]+\.(?:png|jpeg|webp)$/.test(value);
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
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
    if (!match || match[2].length % 4 !== 0) return '';
    return `data:image/${match[1].toLowerCase()};base64,${match[2]}`;
}

/** Rebuild an allowlisted object; imported keys and inherited properties are never copied. */
export function sanitizeSettings(input) {
    const source = record(input) ? input : {};
    const boolean = (key, fallback) => typeof own(source, key) === 'boolean' ? own(source, key) : fallback;
    const design = own(source, 'design');
    const shape = own(source, 'shape');
    const settings = {
        dialoguePromptEnabled: boolean('dialoguePromptEnabled', false),
        dialoguePrompt: typeof own(source,'dialoguePrompt') === 'string' ? own(source,'dialoguePrompt').slice(0,8000) : DEFAULT_DIALOGUE_PROMPT,
        version: 1,
        enabled: boolean('enabled', true),
        namePosition: own(source, 'namePosition') === 'above' && own(source, 'showName') !== false ? 'above' : 'none',
        fontMode: own(source,'fontMode') === 'custom' ? 'custom' : 'theme',
        nameFont: ['pretendard','ridi','gowun','paperlogy','cafe24'].includes(own(source,'nameFont')) ? own(source,'nameFont') : 'pretendard',
        dialogueFont: ['pretendard','ridi','gowun','paperlogy','cafe24'].includes(own(source,'dialogueFont')) ? own(source,'dialogueFont') : 'pretendard',
        nameFontSize: Math.round(boundedNumber(own(source,'nameFontSize'),10,28,12)),
        dialogueFontSize: Math.round(boundedNumber(own(source,'dialogueFontSize'),12,36,15)),
        quoteColorEnabled: boolean('quoteColorEnabled',false),
        quoteColor: typeof own(source,'quoteColor')==='string' && /^#[0-9a-f]{6}$/i.test(own(source,'quoteColor')) ? own(source,'quoteColor') : '#808080',
        quoteStyle: own(source, 'quoteStyle') === 'override' ? 'override' : 'theme',
        design: ['minimal', 'bubble'].includes(design) ? design : 'minimal',
        shape: ['circle', 'rounded'].includes(shape) ? shape : 'circle',
        size: Math.round(boundedNumber(own(source, 'size'), 32, 88, 48)),
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
