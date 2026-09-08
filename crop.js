const clamp = value => Math.min(100, Math.max(0, value));

/** Match object-fit:cover + transform-origin/object-position percentages. */
export function cropAfterDrag(start, dx, dy, width, height, naturalWidth, naturalHeight) {
    if (!(width > 0 && height > 0 && naturalWidth > 0 && naturalHeight > 0)) return { x: start.x, y: start.y };
    const cover = Math.max(width / naturalWidth, height / naturalHeight);
    const overflowX = naturalWidth * cover * start.zoom - width;
    const overflowY = naturalHeight * cover * start.zoom - height;
    const moved = (value, delta, overflow) => overflow > 0.5 ? Math.round(clamp(value - delta / overflow * 100)) : value;
    return { x: moved(start.x, dx, overflowX), y: moved(start.y, dy, overflowY) };
}

/** Capture stays on the same element throughout a mouse, touch, or pen drag. */
export function bindCropDrag(element, { getCrop, onChange }) {
    let drag = null;
    const finish = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const id = drag.pointerId;
        drag = null;
        element.classList.remove('sp-dragging');
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    };
    element.addEventListener('pointerdown', event => {
        if (drag || event.isPrimary === false || event.button !== 0) return;
        const image = element.querySelector('img');
        if (!image?.naturalWidth || !image.naturalHeight) return;
        const rect = element.getBoundingClientRect();
        try { element.setPointerCapture(event.pointerId); } catch { return; }
        drag = { pointerId: event.pointerId, start: { ...getCrop() }, x: event.clientX, y: event.clientY,
            width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
        element.classList.add('sp-dragging');
        event.preventDefault();
    });
    element.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        onChange(cropAfterDrag(drag.start, event.clientX - drag.x, event.clientY - drag.y,
            drag.width, drag.height, drag.naturalWidth, drag.naturalHeight));
        event.preventDefault();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, finish);
    element.addEventListener('keydown', event => {
        const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!directions[event.key]) return;
        const [dx, dy] = directions[event.key], step = event.shiftKey ? 10 : 1, crop = getCrop();
        onChange({ x: clamp(crop.x - dx * step), y: clamp(crop.y - dy * step) });
        event.preventDefault();
    });
}
