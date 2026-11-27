const list = document.getElementById('trips');
const card = list.firstElementChild;
const create = document.getElementById('create-trip');
const status = document.getElementById('trip-list-status');
const syncIcon = document.getElementById('trip-sync-icon');
const syncText = document.getElementById('trip-sync-text');
const retrySync = document.getElementById('retry-trip-sync');
const liveSite = document.getElementById('live-trip-site');
const removeDialog = document.getElementById('remove-trip-dialog');
const removeDescription = document.getElementById('remove-trip-description');
const cloudHosted = document.documentElement.dataset.cloud === 'true';
const githubHosted = window.location.hostname === 'fish550212.github.io';
const sheetsApi = 'https://script.google.com/macros/s/AKfycbw0XuCer50X1oM-joR2A5bxCOjaCoA_HV8B2l-r8iNUdzx1w0efI6PkdhvZmUxPwhZe/exec';
let tripListRequest;
let hasLoadedTrips = false;
let pendingRemoval;

function showSync(icon, label) {
    syncIcon.className = 'fa-solid ' + icon;
    syncText.textContent = label;
}

function tripUrl(id) {
    return './code_artifact.html' + (id ? '?trip=' + encodeURIComponent(id) : '');
}

async function fetchTripApi(path, options = {}) {
    if (!githubHosted) return fetch('./' + path, options);
    const {method = 'GET'} = options;
    const params = new URL(path, window.location.href).searchParams;
    const id = params.get('trip');
    const action = method === 'POST' && params.has('copy') ? 'travel-copy'
        : {GET:'travel-list',POST:'travel-create',DELETE:'travel-delete'}[method];
    const response = await fetch(sheetsApi, {
        method:'POST', headers:{'Content-Type':'text/plain;charset=UTF-8'},
        body:JSON.stringify({action,id})
    });
    if (!response.ok) return response;
    const data = await response.json();
    const status = data.error ? ({not_found:404,locked:423}[data.error] ?? 503) : 200;
    return new Response(JSON.stringify(data), {status});
}

function formatTripDates(departure, returning) {
    if (!departure || !returning) return '';
    const start = departure.replaceAll('-', '/');
    if (departure === returning) return start;
    const end = departure.slice(0, 4) === returning.slice(0, 4) ? returning.slice(5) : returning;
    return start + ' – ' + end.replaceAll('-', '/');
}

document.addEventListener('click', event => {
    for (const settings of list.querySelectorAll('.trip-settings[open]')) {
        if (!settings.contains(event.target)) settings.open = false;
    }
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || removeDialog.open) return;
    const settings = list.querySelector('.trip-settings[open]');
    if (settings) {
        settings.open = false;
        settings.querySelector('summary').focus();
    }
});

function confirmRemoval(trip, entry, button) {
    pendingRemoval = {trip, entry, button};
    removeDescription.textContent = '確定要從旅行列表刪除「' + trip.title + '」嗎？';
    removeDialog.returnValue = '';
    removeDialog.showModal();
}

removeDialog.addEventListener('close', () => {
    const removal = pendingRemoval;
    pendingRemoval = undefined;
    if (removeDialog.returnValue === 'delete' && removal) {
        void removeTrip(removal.trip, removal.entry, removal.button);
    }
});

async function removeTrip(trip, entry, button) {
    button.disabled = true;
    status.textContent = '';
    try {
        const endpoint = 'api/itinerary' + (trip.id ? '?trip=' + encodeURIComponent(trip.id) : '');
        const response = await fetchTripApi(endpoint, {method: 'DELETE'});
        if (!githubHosted && response.status === 403) {
            window.location.href = '/signin-with-chatgpt?return_to=%2F';
            return;
        }
        if (response.status === 423) {
            status.textContent = '這個旅程已上鎖。請先在旅程頁解除密碼鎖定，再刪除。';
            return;
        }
        if (!response.ok) throw new Error('Could not remove trip');
        const neighbor = entry.nextElementSibling ?? entry.previousElementSibling;
        entry.remove();
        (neighbor?.querySelector('summary') ?? create).focus();
        if (!list.firstElementChild) status.textContent = '目前沒有旅行。';
    } catch {
        status.textContent = '目前無法刪除旅程，請稍後再試。';
    } finally {
        button.disabled = false;
    }
}

async function copyTrip(trip, button) {
    button.disabled = true;
    status.textContent = '';
    try {
        const params = new URLSearchParams({copy:'1'});
        if (trip.id) params.set('trip', trip.id);
        const response = await fetchTripApi('api/trips?' + params, {method:'POST'});
        if (!githubHosted && response.status === 403) {
            window.location.href = '/signin-with-chatgpt?return_to=%2F';
            return;
        }
        if (!response.ok) throw new Error('Could not copy trip');
        const {id} = await response.json();
        window.location.href = tripUrl(id);
    } catch {
        status.textContent = '目前無法複製旅程，請稍後再試。';
    } finally {
        button.disabled = false;
    }
}

function loadTrips() {
    tripListRequest ??= fetchTrips().finally(() => { tripListRequest = undefined; });
    return tripListRequest;
}

function refreshLocalTripCard() {
    let draft;
    try { draft = JSON.parse(sessionStorage.getItem('yilan_trip_preview')); } catch { /* Storage can be unavailable for local files. */ }
    const preview = new URLSearchParams(window.location.hash.slice(1));
    const fromFile = window.location.protocol === 'file:';
    const title = (fromFile && preview.get('title')) || draft?.title;
    const departure = (fromFile && preview.get('departureDate')) || draft?.dateRange?.departureDate || draft?.dates?.day1;
    const returning = (fromFile && preview.get('returnDate')) || draft?.dateRange?.returnDate || draft?.dates?.day3;
    if (title) card.querySelector('strong').textContent = title;
    if (departure && returning) {
        const dates = card.querySelector('.trip-dates');
        dates.textContent = formatTripDates(departure, returning);
        dates.hidden = false;
    }
}

async function fetchTrips() {
    if (!cloudHosted && !githubHosted) {
        refreshLocalTripCard();
        card.hidden = false;
        status.textContent = '';
        list.removeAttribute('aria-busy');
        showSync('fa-desktop', '本機預覽');
        liveSite.hidden = false;
        return false;
    }
    retrySync.hidden = true;
    showSync('fa-cloud', '同步中');
    if (!hasLoadedTrips) {
        list.setAttribute('aria-busy', 'true');
        status.textContent = '資料載入中…';
    }
    try {
        const response = await fetchTripApi('api/trips', {cache: 'no-store'});
        if (!response.ok) throw new Error('Could not load trips');
        const {trips} = await response.json();
        list.replaceChildren(...trips.map(trip => {
            const entry = card.cloneNode(true);
            entry.hidden = false;
            const settings = entry.querySelector('.trip-settings');
            settings.hidden = false;
            settings.querySelector('summary').setAttribute('aria-label', '「' + trip.title + '」行程設定');
            entry.querySelector('a').href = tripUrl(trip.id);
            entry.querySelector('strong').textContent = trip.title;
            const dates = entry.querySelector('.trip-dates');
            dates.textContent = formatTripDates(trip.departureDate, trip.returnDate);
            dates.hidden = !dates.textContent;
            const copyButton = entry.querySelector('.copy-trip');
            copyButton.setAttribute('aria-label', '複製「' + trip.title + '」');
            copyButton.title = '複製旅程';
            copyButton.addEventListener('click', () => copyTrip(trip, copyButton));
            const button = entry.querySelector('.delete-trip');
            button.setAttribute('aria-label', '刪除「' + trip.title + '」');
            button.title = '刪除旅程';
            button.addEventListener('click', () => confirmRemoval(trip, entry, button));
            return entry;
        }));
        status.textContent = trips.length ? '' : '目前沒有旅行。';
        if (!hasLoadedTrips) list.classList.add('data-reveal');
        hasLoadedTrips = true;
        showSync('fa-circle-check', '雲端已同步');
        return true;
    } catch {
        if (!hasLoadedTrips) status.textContent = '暫時無法載入旅行列表。';
        showSync('fa-circle-exclamation', '暫時無法同步');
        retrySync.hidden = false;
        return false;
    } finally {
        list.removeAttribute('aria-busy');
    }
}

create.addEventListener('click', async () => {
    if (!cloudHosted && !githubHosted) {
        window.location.href = liveSite.href;
        return;
    }
    create.disabled = true;
    status.textContent = '';
    try {
        const response = await fetchTripApi('api/trips', {method: 'POST'});
        if (!githubHosted && response.status === 403) {
            window.location.href = '/signin-with-chatgpt?return_to=%2F';
            return;
        }
        if (!response.ok) throw new Error('Could not create trip');
        const {id} = await response.json();
        window.location.href = tripUrl(id);
    } catch {
        status.textContent = '目前無法新增旅程，請稍後再試。';
    } finally {
        create.disabled = false;
    }
});
retrySync.addEventListener('click', loadTrips);
window.addEventListener('pageshow', event => {
    if (event.persisted) void loadTrips();
});
void loadTrips();
