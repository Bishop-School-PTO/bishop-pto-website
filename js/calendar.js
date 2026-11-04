// Calendar widget:
//  - click a calendar name to show or hide its events
//  - the embed is rebuilt from the calendars still switched on
//  - phones get Google's list ("agenda") view instead of the wide month grid
//  - the "open in a new window" link is kept in step with both
// Without JavaScript the toggles stay hidden and both calendars are shown.
(() => {
  const card = document.querySelector('#calendar .calendar-card');
  const legend = document.querySelector('[data-calendar-toggles]');
  const frame = document.querySelector('[data-calendar-frame]');
  const openLink = document.querySelector('[data-calendar-open]');
  if (!card || !legend || !frame || !openLink) return;

  const hint = card.querySelector('.calendar-toggle-hint');
  const buttons = [...legend.querySelectorAll('[data-calendar]')];
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

  const refresh = () => {
    const url = embedUrl();
    frame.src = url;
    openLink.href = url;
  };

  // Reveal the controls now that we know they will work.
  card.classList.add('calendar-js');
  legend.hidden = false;
  if (hint) hint.hidden = false;

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Keep at least one calendar showing so the widget is never empty.
      if (isOn(btn) && buttons.filter(isOn).length === 1) return;
      btn.setAttribute('aria-pressed', String(!isOn(btn)));
      refresh();
    });
  });

  // The markup already holds the month view, so only reload on phones.
  if (phone.matches) refresh();
  else openLink.href = embedUrl();
  phone.addEventListener('change', refresh);
})();
