// Calendar widget:
//  - each calendar is one pill: [show/hide toggle | add to my calendar | open in new window]
//  - the embed is rebuilt from the calendars still switched on
//  - phones get Google's list ("agenda") view instead of the wide month grid
//  - add-to-calendar menus close on outside click or Escape
// Without JavaScript the toggles are inert labels and both calendars are shown;
// the add and open buttons still work.
(() => {
  const card = document.querySelector('#calendar .calendar-card');
  const legend = document.querySelector('[data-calendar-toggles]');
  const frame = document.querySelector('[data-calendar-frame]');
  if (!card || !legend || !frame) return;

  const hint = card.querySelector('.calendar-toggle-hint');
  const buttons = [...legend.querySelectorAll('[data-calendar]')];
  const menus = [...legend.querySelectorAll('.calendar-pill-add')];
  const phone = window.matchMedia('(max-width: 720px)');

  const isOn = (btn) => btn.getAttribute('aria-pressed') === 'true';

  const embedUrl = () => {
    const params = new URLSearchParams();
    buttons.filter(isOn).forEach((btn) => {
      params.append('src', btn.dataset.calendar);
      params.append('color', btn.dataset.color);
    });
    params.set('ctz', 'America/New_York');
    params.set('mode', phone.matches ? 'AGENDA' : 'MONTH');
    params.set('showTitle', '0');
    params.set('showPrint', '0');
    params.set('showTabs', '0');
    params.set('showCalendars', '0');
    params.set('showTz', '0');
    params.set('bgcolor', '#FFFFFF');
    return `https://calendar.google.com/calendar/embed?${params.toString()}`;
  };

  const refresh = () => { frame.src = embedUrl(); };

  const syncPill = (btn) => {
    const pill = btn.closest('.calendar-pill');
    if (pill) pill.classList.toggle('is-off', !isOn(btn));
  };

  // Enable the toggles now that we know they will work.
  card.classList.add('calendar-js');
  if (hint) hint.hidden = false;

  buttons.forEach((btn) => {
    btn.disabled = false;
    syncPill(btn);
    btn.addEventListener('click', () => {
      // Keep at least one calendar showing so the widget is never empty.
      if (isOn(btn) && buttons.filter(isOn).length === 1) return;
      btn.setAttribute('aria-pressed', String(!isOn(btn)));
      syncPill(btn);
      refresh();
    });
  });

  // Only one add menu open at a time.
  menus.forEach((menu) => {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      menus.forEach((other) => { if (other !== menu) other.open = false; });
    });
  });

  document.addEventListener('click', (event) => {
    menus.forEach((menu) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    menus.forEach((menu) => {
      if (!menu.open) return;
      menu.open = false;
      menu.querySelector('summary').focus();
    });
  });

  // The markup already holds the month view, so only reload on phones.
  if (phone.matches) refresh();
  phone.addEventListener('change', refresh);
})();
