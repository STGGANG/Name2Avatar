/** Global settings remain in the v1 shape; bot/group overrides live in scopes. */
import { normalizeName, sanitizeSettings } from './core.js?v=1.0.1-appearance';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => value !== null && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;

function validScopeKey(key) {
    if (typeof key !== 'string' || key.length > 512) return false;
    const match = /^(character|group):(.+)$/u.exec(key);
    if (!match || match[2] !== match[2].trim() || /[\u0000-\u001f\u007f]/u.test(key)) return false;
    return match[1] !== 'character' || (!/[\\/]/u.test(match[2]) && !['.', '..'].includes(match[2]));
}

function scopeLabel(label, fallback) {
    return typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : fallback.slice(0, 200);
}

function hashKey(key) {
    let hash = 2166136261;
    for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
    return hash.toString(36);
}

/** Allowlist imports and ensure image IDs cannot collide between different scopes. */
export function sanitizeStore(input) {
    const store = { ...sanitizeSettings(input), scopes: [] };
    const entries = own(input, 'scopes');
    const keys = new Set();
    if (Array.isArray(entries)) {
        for (const entry of entries) {
            if (store.scopes.length === 200) break;
            if (!record(entry)) continue;
            const key = own(entry, 'key');
            if (!validScopeKey(key) || keys.has(key)) continue;
            keys.add(key);
            store.scopes.push({
                key,
                label: scopeLabel(own(entry, 'label'), key),
                settings: sanitizeSettings(own(entry, 'settings')),
            });
        }
    }
    const ids = new Set();
    for (const { key, settings } of [{ key: 'global', settings: store }, ...store.scopes]) {
        for (const profile of settings.profiles) {
            if (ids.has(profile.id) || profile.id.length > 100) {
                const base = `scope-${hashKey(key)}-${profile.id}`.slice(0, 90);
                let id = base;
                let suffix = 2;
                while (ids.has(id)) id = `${base}-${suffix++}`;
                profile.id = id;
            }
            ids.add(profile.id);
        }
    }
    return store;
}

/** A bot is identified by avatar filename, which is stable when cards are reordered. */
export function getActiveScope(context) {
    if (!record(context)) return null;
    const groupId = own(context, 'groupId');
    if (groupId !== undefined && groupId !== null && groupId !== '') {
        if (!['string', 'number'].includes(typeof groupId) || (typeof groupId === 'number' && !Number.isFinite(groupId))) return null;
        const key = `group:${groupId}`;
        if (!validScopeKey(key)) return null;
        const groups = own(context, 'groups');
        const group = (Array.isArray(groups) ? groups : [])
            .find(item => record(item) && String(own(item, 'id')) === String(groupId));
        return { key, label: scopeLabel(own(group, 'name'), `그룹 ${groupId}`) };
    }
    const characterId = own(context, 'characterId');
    if (characterId === undefined || characterId === null || characterId === '') return null;
    const characters = own(context, 'characters');
    const character = Array.isArray(characters) ? own(characters, characterId) : undefined;
    if (!record(character)) return null;
    const avatar = own(character, 'avatar');
    if (typeof avatar !== 'string' || !validScopeKey(`character:${avatar}`)) return null;
    return {
        key: `character:${avatar}`,
        label: scopeLabel(own(character, 'name'), scopeLabel(own(own(character, 'data'), 'name'), avatar)),
    };
}

/** Reading an unconfigured bot inherits globals without creating a local override. */
export function getEditingSettings(store, scopeKey = '') {
    const scopes = own(store, 'scopes');
    const scope = typeof scopeKey === 'string' && scopeKey && Array.isArray(scopes)
        ? scopes.find(entry => own(entry, 'key') === scopeKey) : undefined;
    return scope ? scope.settings : store;
}

export function getEffectiveSettings(store) {
    // Presentation switches are global; only person mappings are scoped.
    return store;
}

/** Update only the selected scope; callers may pass null to update global settings. */
export function setScopeSettings(store, scope, next) {
    const sanitized = sanitizeStore(store);
    if (scope === null || scope === undefined) {
        return sanitizeStore({ ...sanitizeSettings(next), scopes: sanitized.scopes });
    }
    const key = own(scope, 'key');
    if (!validScopeKey(key)) return sanitized;
    const entry = { key, label: scopeLabel(own(scope, 'label'), key), settings: sanitizeSettings(next) };
    const index = sanitized.scopes.findIndex(item => item.key === key);
    if (index >= 0) sanitized.scopes[index] = entry;
    else if (sanitized.scopes.length < 200) sanitized.scopes.push(entry);
    return sanitizeStore(sanitized);
}

export function allProfiles(store) {
    const profiles = own(store, 'profiles');
    const scopes = own(store, 'scopes');
    return [
        ...(Array.isArray(profiles) ? profiles : []),
        ...(Array.isArray(scopes) ? scopes.flatMap(scope => {
            const entries = own(own(scope, 'settings'), 'profiles');
            return Array.isArray(entries) ? entries : [];
        }) : []),
    ];
}

/** Atomically add, edit, copy, or move one person without changing other scopes. */
export function savePerson(store, profile, target = null, original = null) {
    const next = sanitizeStore(store);
    const names = [profile.name, ...(profile.aliases ?? [])].map(normalizeName);
    if (!names[0] || names.some(name => name.length > 100) || names.length > 33) {
        throw new Error('이름은 각각 100자 이하, 한 인물당 33개까지 입력해 주세요.');
    }
    if (target && !validScopeKey(target.key)) throw new Error('현재 봇을 확인한 뒤 다시 선택해 주세요.');
    let destination = next;
    if (target) {
        let bucket = next.scopes.find(scope => scope.key === target.key);
        if (!bucket) {
            if (next.scopes.length >= 200) throw new Error('봇 전용 등록은 최대 200개 봇까지 지원합니다.');
            bucket = { key: target.key, label: scopeLabel(target.label, target.key), settings: sanitizeSettings({}) };
            next.scopes.push(bucket);
        }
        destination = bucket.settings;
    }
    const sameOriginal = person => person.id === original?.id;
    const conflict = destination.profiles.find(person => !sameOriginal(person)
        && [person.name, ...person.aliases].some(name => names.includes(normalizeName(name))));
    if (conflict) throw new Error(`이 적용 범위의 “${conflict.name}”에 같은 이름이 있어요. 기존 등록을 편집해 주세요.`);
    if (destination.profiles.filter(person => !sameOriginal(person)).length >= 150) {
        throw new Error('한 적용 범위에는 최대 150명을 등록할 수 있어요.');
    }
    if (original) {
        const source = original.key ? next.scopes.find(scope => scope.key === original.key)?.settings : next;
        if (!source?.profiles.some(person => person.id === original.id)) throw new Error('원래 등록이 바뀌었습니다. 목록에서 다시 선택해 주세요.');
        source.profiles = source.profiles.filter(person => person.id !== original.id);
    }
    destination.profiles.push(profile);
    return sanitizeStore(next);
}

export function removePerson(store, original) {
    const next = sanitizeStore(store);
    const source = original.key ? next.scopes.find(scope => scope.key === original.key)?.settings : next;
    if (source) source.profiles = source.profiles.filter(person => person.id !== original.id);
    return next;
}
