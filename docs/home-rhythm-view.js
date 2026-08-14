const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));

export function renderHouseholdRhythm(timeline, formatDate) {
  const fmt = value => formatDate(value);
  if (!timeline.dates.length) return `<section class="rhythm-week" aria-labelledby="rhythm-title"><div class="section-heading"><div><p>HOUSEHOLD TIMELINE</p><h2 id="rhythm-title">Household rhythm</h2></div></div><p class="rhythm-explainer">Receipts appear here by purchase date, not upload date.</p><p class="empty-state">Import or add a receipt to start the timeline.</p></section>`;
  const range = `${fmt(timeline.dates[0].date)} – ${fmt(timeline.dates.at(-1).date)}`;
  const todayControl = timeline.selectedDate === timeline.todayDate ? '<span class="latest-marker">Today selected</span>' : `<button type="button" class="plain" data-rhythm-jump="${timeline.todayDate}">Jump to today</button>`;
  return `<section class="rhythm-week" aria-labelledby="rhythm-title"><div class="section-heading rhythm-heading"><div><p>HOUSEHOLD TIMELINE</p><h2 id="rhythm-title">Household rhythm</h2></div><span>${range}</span></div><div class="rhythm-navigation" aria-label="Navigate household dates"><button type="button" class="secondary" data-rhythm-jump="${timeline.previousDate || ""}"${timeline.previousDate ? "" : " disabled"}>Previous</button><span class="selected-purchase-date">Selected date <b>${fmt(timeline.selectedDate)}</b></span><button type="button" class="secondary" data-rhythm-jump="${timeline.nextDate || ""}"${timeline.nextDate ? "" : " disabled"}>Next</button>${todayControl}</div><p class="rhythm-explainer">Past cards use receipt purchase dates. Today and upcoming days show the household rhythm without changing receipt chronology.</p><ol class="week-strip purchase-date-strip${timeline.dates.length <= 4 ? " is-sparse" : ""}${timeline.dates.length <= 6 ? " is-compact" : ""}">${timeline.dates.map(entry => {
    const date = new Date(`${entry.date}T12:00:00`);
    const gap = entry.gapDays > 1 ? `<small class="date-gap">${entry.gapDays - 1} quiet days</small>` : '<small class="date-gap" aria-hidden="true"></small>';
    const firstFuture = timeline.dates.find(item => item.isFuture)?.date;
    const calendarLabel = `${new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date)}, ${new Intl.DateTimeFormat("en-IN", { month: "short" }).format(date)}`;
    const dayLabel = entry.isToday ? "Today" : entry.isFuture && entry.date === firstFuture ? "Tomorrow" : calendarLabel;
    const activity = entry.receiptCount ? `${entry.receiptCount} receipt${entry.receiptCount === 1 ? "" : "s"}` : entry.isFuture ? "Upcoming" : entry.isToday ? "No new action" : "No receipt";
    return `<li class="week-day${entry.selected ? " is-selected" : ""}${entry.isToday ? " is-today" : ""}${entry.isFuture ? " is-future" : ""}"${entry.selected ? ' aria-current="date"' : ""}>${gap}<button type="button" data-rhythm-date="${entry.date}" aria-label="Show household activity for ${fmt(entry.date)}"><time datetime="${entry.date}"><span>${dayLabel}</span><b>${date.getDate()}</b></time><small${entry.receiptCount ? "" : ' class="quiet"'}>${activity}</small></button></li>`;
  }).join("")}</ol></section>`;
}

export function renderBalanceSummary({ balanceText, guidance, actionLabel, actionAmount, archived = false }) {
  const next = !guidance ? "" : `<div class="balance-next"><span><b>Next action</b>${escapeHtml(guidance)}</span>${actionLabel ? `<button id="settle" aria-label="${escapeHtml(`${actionLabel} ${actionAmount}`)}">Record payment</button>` : ""}</div>`;
  return `<section class="balance-card" aria-labelledby="balance-title"><div class="balance-summary"><small id="balance-title">Current balance</small><strong>${escapeHtml(balanceText)}</strong><span>Shared items split equally</span></div>${archived ? "" : next}</section>`;
}

export function renderCommandActions(archived = false) {
  return archived ? "" : '<nav class="command-actions primary-actions" aria-label="Ledger actions"><button id="import-pdf">Import receipt</button><button id="add" class="secondary">Add expense</button><button id="open-settings" class="settings-action" aria-controls="view-household">Household settings</button></nav>';
}
