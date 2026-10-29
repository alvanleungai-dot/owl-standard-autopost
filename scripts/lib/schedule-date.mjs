const MONTHS = [
  ["Jan", "January"], ["Feb", "February"], ["Mar", "March"], ["Apr", "April"],
  ["May", "May"], ["Jun", "June"], ["Jul", "July"], ["Aug", "August"],
  ["Sep", "September"], ["Oct", "October"], ["Nov", "November"], ["Dec", "December"],
];

export function inputShowsScheduledDate(value, isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const text = String(value || "");
  const names = MONTHS[Number(month) - 1];
  if (!names) return false;
  return new RegExp(`\\b0?${Number(day)}\\b`).test(text) &&
    new RegExp(`\\b(?:${names.join("|")})\\b`, "i").test(text) &&
    new RegExp(`\\b${year}\\b`).test(text);
}

export function allDateInputsMatch(values, isoDate) {
  return Array.isArray(values) && values.length > 0 &&
    values.every((value) => inputShowsScheduledDate(value, isoDate));
}
