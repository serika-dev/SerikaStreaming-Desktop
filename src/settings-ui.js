// Load current settings and bind controls

const toggles = document.querySelectorAll('.toggle');
const zoom = document.getElementById('zoom');
const zoomValue = document.getElementById('zoom-value');
const presenceStatus = document.getElementById('presence-status');

async function init() {
  const settings = await window.serika.getSettings();

  toggles.forEach((el) => {
    const key = el.dataset.key;
    el.checked = !!settings[key];
    el.addEventListener('change', () => {
      window.serika.setSetting(key, el.checked);
      if (key === 'discordPresence') setTimeout(refreshStatus, 500);
    });
  });

  if (zoom) {
    zoom.value = settings.zoomFactor || 1;
    updateZoomLabel(zoom.value);
    zoom.addEventListener('input', () => updateZoomLabel(zoom.value));
    zoom.addEventListener('change', () => {
      window.serika.setSetting('zoomFactor', parseFloat(zoom.value));
    });
  }

  refreshStatus();
  setInterval(refreshStatus, 4000);
}

function updateZoomLabel(val) {
  if (zoomValue) zoomValue.textContent = Math.round(parseFloat(val) * 100) + '%';
}

async function refreshStatus() {
  try {
    const status = await window.serika.getStatus();
    if (!status.presenceActive) {
      presenceStatus.textContent = 'Disabled';
      presenceStatus.className = 'badge';
    } else if (status.discordConnected) {
      presenceStatus.textContent = 'Connected';
      presenceStatus.className = 'badge connected';
    } else {
      presenceStatus.textContent = 'Waiting for Discord';
      presenceStatus.className = 'badge active';
    }
  } catch {
    presenceStatus.textContent = 'Unknown';
    presenceStatus.className = 'badge';
  }
}

init();
