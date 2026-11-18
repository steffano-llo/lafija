export type MoveActionResult = { ok: true } | { ok: false; message: string };

/** What the user sees when the server refuses a move; the card goes back where it was. */
export const MOVE_REFUSAL_MESSAGES = {
  not_found: "This application is no longer on your board. Refresh the page to see the latest version.",
  invalid: "That stage is not available anymore. Refresh the page to see the latest version.",
} as const;

export const MOVE_FAILED_MESSAGE = "The move could not be saved. Check your connection and try again.";

/** Keyboard and screen reader instructions for the board. */
export const BOARD_INSTRUCTIONS =
  "To pick up a card, focus it and press Space or Enter. Use the arrow keys to move it within a column " +
  "or to another column. Press Space or Enter again to drop it, or Escape to cancel.";

export type CardLabel = { role: string; companyName: string };

export const cardName = (card: CardLabel | undefined) => (card ? `${card.role} at ${card.companyName}` : "Card");

export const placeIn = (column: string, index: number, count: number) =>
  `${column}, position ${index + 1} of ${count}`;
