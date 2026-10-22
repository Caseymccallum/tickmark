/** Customer-facing hosted catalogue. Stripe prices are checked against this before Checkout. */
const monthlyAmountPence = 4900;
const monthlyDisplay = `${new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: 'GBP', maximumFractionDigits: 0,
}).format(monthlyAmountPence / 100)} per month`;

export const COMMERCIAL_PRICE = Object.freeze({
  currency: 'gbp',
  interval: 'month',
  unitAmount: monthlyAmountPence,
  display: monthlyDisplay,
});
