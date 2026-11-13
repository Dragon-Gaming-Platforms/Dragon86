(() => {
  const coreSelect = document.querySelector('#core');
  const picker = document.querySelector('#game');
  const player = document.querySelector('#player');
  const error = document.querySelector('#error');
  const restart = document.querySelector('#restart');
  restart.addEventListener('click', () => location.reload());
  const queryCore = new URLSearchParams(location.search).get('core');
  const isPsxApp = true;
  if (isPsxApp) {
    coreSelect.value = 'psx';
    coreSelect.disabled = true;
    document.title = 'PlayStation · EmulatorJS';
    document.querySelector('h1').textContent = 'PlayStation';
    document.querySelector('header p').textContent = 'PS1 emulation powered by EmulatorJS. Bring your own disc image.';
  }
  function loadGame(file) {
    if (!file) return;
    error.textContent = '';
    player.replaceChildren();
    window.EJS_player = '#player';
    window.EJS_core = isPsxApp ? 'psx' : coreSelect.value;
    window.EJS_gameUrl = file;
    window.EJS_gameName = file.name;
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
    window.EJS_threads = false;
    window.EJS_startOnLoaded = true;
    window.EJS_color = '#5b8cff';
    const loader = document.createElement('script');
    loader.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    document.body.append(loader);
    picker.disabled = true;
    restart.hidden = false;
    loader.onerror = () => {
      picker.disabled = false;
      restart.hidden = true;
      error.textContent = 'Could not load EmulatorJS. Check your internet connection and try again.';
    };
  }
  picker.addEventListener('change', () => loadGame(picker.files?.[0]));
  coreSelect.addEventListener('change', () => { picker.value = ''; });
})();
