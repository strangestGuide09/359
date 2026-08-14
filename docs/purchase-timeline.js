const dayNumber = value => Math.round(new Date(`${value}T12:00:00Z`).getTime() / 86400000);

export function purchaseDateTimeline(purchases, requestedDate) {
  const counts = new Map();
  for (const purchase of purchases || []) {
    const date = String(purchase?.purchased_on || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  const dates = [...counts.keys()].sort();
  const selectedDate = dates.includes(requestedDate) ? requestedDate : dates.at(-1) || null;
  const selectedIndex = selectedDate ? dates.indexOf(selectedDate) : -1;
  return {
    dates: dates.map((date, index) => ({
      date,
      receiptCount: counts.get(date),
      gapDays: index ? dayNumber(date) - dayNumber(dates[index - 1]) : 0,
      selected: date === selectedDate
    })),
    selectedDate,
    previousDate: selectedIndex > 0 ? dates[selectedIndex - 1] : null,
    nextDate: selectedIndex >= 0 && selectedIndex < dates.length - 1 ? dates[selectedIndex + 1] : null,
    latestDate: dates.at(-1) || null
  };
}

export function householdRhythmTimeline(purchases, todayDate, requestedDate, futureDays = 3) {
  const receiptTimeline = purchaseDateTimeline(purchases, requestedDate);
  const dates = new Set(receiptTimeline.dates.map(item => item.date));
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(todayDate) ? new Date(`${todayDate}T12:00:00Z`) : new Date();
  const todayKey = anchor.toISOString().slice(0, 10);
  for (let offset = 0; offset <= futureDays; offset += 1) {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() + offset);
    dates.add(date.toISOString().slice(0, 10));
  }
  const ordered = [...dates].sort();
  const selectedDate = ordered.includes(requestedDate) ? requestedDate : todayKey;
  const selectedIndex = ordered.indexOf(selectedDate);
  const receiptCounts = new Map(receiptTimeline.dates.map(item => [item.date, item.receiptCount]));
  return {
    dates: ordered.map((date, index) => ({
      date,
      receiptCount: receiptCounts.get(date) || 0,
      gapDays: index ? dayNumber(date) - dayNumber(ordered[index - 1]) : 0,
      selected: date === selectedDate,
      isToday: date === todayKey,
      isFuture: date > todayKey
    })),
    selectedDate,
    previousDate: selectedIndex > 0 ? ordered[selectedIndex - 1] : null,
    nextDate: selectedIndex >= 0 && selectedIndex < ordered.length - 1 ? ordered[selectedIndex + 1] : null,
    latestReceiptDate: receiptTimeline.latestDate,
    todayDate: todayKey
  };
}
