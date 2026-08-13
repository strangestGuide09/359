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
