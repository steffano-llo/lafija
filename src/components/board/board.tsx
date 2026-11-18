"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { moveApplicationAction } from "@/app/dashboard/board/actions";
import { formatAppliedDate } from "@/components/applications/format";
import type { BoardCard, BoardColumn } from "@/server/board";
import { locate, moveCard, type Columns } from "./columns";
import { BOARD_INSTRUCTIONS, MOVE_FAILED_MESSAGE, cardName, placeIn } from "./messages";

function toColumns(columns: BoardColumn[]): Columns {
  return Object.fromEntries(columns.map((column) => [column.id, column.cards.map((card) => card.id)]));
}

function Card({ card }: { card: BoardCard }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    attributes: { roleDescription: "draggable card" },
  });
  // dnd-kit stops the click that ends a drag from propagating but does not cancel it, so dropping
  // a card grabbed by its link would follow the link. Swallow clicks until shortly after a drag ends.
  const recentlyDragged = useRef(false);
  useEffect(() => {
    if (isDragging) {
      recentlyDragged.current = true;
      return;
    }
    const timer = setTimeout(() => {
      recentlyDragged.current = false;
    }, 300);
    return () => clearTimeout(timer);
  }, [isDragging]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={`${cardName(card)}, applied ${formatAppliedDate(card.appliedAt)}`}
      className={`cursor-grab touch-none rounded-lg bg-card p-3 text-sm ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isDragging ? "opacity-60 shadow-lg" : ""
      }`}
    >
      <p className="font-medium">{card.companyName}</p>
      <p>
        {/* Opens the detail page. Its own keys stay with the link, so Enter follows it instead of
            picking up the card, and a click (no drag distance) never starts a drag. */}
        <Link
          href={`/dashboard/applications/${card.id}`}
          draggable={false}
          onClick={(event) => {
            if (recentlyDragged.current) event.preventDefault();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          aria-label={`Open ${cardName(card)}`}
          className="underline-offset-4 hover:underline"
        >
          {card.role}
        </Link>
      </p>
      <p className="text-xs text-muted-foreground">Applied {formatAppliedDate(card.appliedAt)}</p>
    </li>
  );
}

function Column({ column, cards }: { column: BoardColumn; cards: BoardCard[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const headingId = `column-${column.id}`;

  return (
    <section aria-labelledby={headingId} className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/50 p-3">
      <h2 id={headingId} className="flex items-center justify-between text-sm font-medium">
        {column.name}
        <span className="text-muted-foreground">
          {cards.length}
          <span className="sr-only"> {cards.length === 1 ? "application" : "applications"}</span>
        </span>
      </h2>
      <SortableContext id={column.id} items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          aria-labelledby={headingId}
          className={`flex min-h-24 flex-col gap-2 rounded-lg p-1 ${isOver ? "ring-2 ring-ring/50" : ""}`}
        >
          {cards.map((card) => (
            <Card key={card.id} card={card} />
          ))}
        </ul>
      </SortableContext>
      {cards.length === 0 && <p className="px-1 text-xs text-muted-foreground">No applications.</p>}
    </section>
  );
}

/**
 * Kanban board: drag cards within and between columns with the mouse, touch or keyboard.
 * The move shows at once; if the server refuses it, the board goes back and shows why.
 */
export function Board({ columns }: { columns: BoardColumn[] }) {
  const dndId = useId();
  const [source, setSource] = useState(columns);
  const [items, setItems] = useState(() => toColumns(columns));
  // State when the current drag started: where to go back to on cancel or refusal.
  const [start, setStart] = useState<{ items: Columns; column: string; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // New server data (after a move is saved or the page refreshes) replaces the local state.
  if (source !== columns) {
    setSource(columns);
    setItems(toColumns(columns));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const cards = new Map(columns.flatMap((column) => column.cards.map((card) => [card.id, card] as const)));
  const names = new Map(columns.map((column) => [column.id, column.name]));
  const describe = (id: UniqueIdentifier) => {
    const at = locate(items, String(id));
    return at ? placeIn(names.get(at.column) ?? "a column", at.index, items[at.column].length) : "no column";
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${cardName(cards.get(String(active.id)))}, in ${describe(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${cardName(cards.get(String(active.id)))} is now in ${describe(active.id)}.`
        : `${cardName(cards.get(String(active.id)))} is not over a column.`,
    onDragEnd: ({ active }) => `${cardName(cards.get(String(active.id)))} was dropped in ${describe(active.id)}.`,
    onDragCancel: ({ active }) =>
      `Moving ${cardName(cards.get(String(active.id)))} was cancelled. It is back where it was.`,
  };

  function handleDragStart({ active }: DragStartEvent) {
    const at = locate(items, String(active.id));
    if (!at) return;
    setError(null);
    setStart({ items, ...at });
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const activeColumn = locate(items, String(active.id))?.column;
    const overColumn = over.id in items ? String(over.id) : locate(items, String(over.id))?.column;
    // Within a column the sortable strategy animates the order; only cross-column moves change state here.
    if (activeColumn && overColumn && activeColumn !== overColumn) {
      setItems((current) => moveCard(current, String(active.id), String(over.id)));
    }
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const origin = start;
    setStart(null);
    if (!origin) return;
    const next = over ? moveCard(items, String(active.id), String(over.id)) : items;
    const at = locate(next, String(active.id));
    setItems(next);
    if (!at || (at.column === origin.column && at.index === origin.index)) return;

    startTransition(async () => {
      let message: string | null = null;
      try {
        const result = await moveApplicationAction(String(active.id), at.column, at.index);
        if (!result.ok) message = result.message;
      } catch {
        message = MOVE_FAILED_MESSAGE;
      }
      if (message) {
        setItems(origin.items);
        setError(message);
      }
    });
  }

  function handleDragCancel() {
    if (start) setItems(start.items);
    setStart(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <p id={`${dndId}-help`} className="text-sm text-muted-foreground">
        {BOARD_INSTRUCTIONS}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {pending ? "Saving the move…" : ""}
      </p>
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ announcements, screenReaderInstructions: { draggable: BOARD_INSTRUCTIONS } }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              cards={(items[column.id] ?? []).flatMap((id) => {
                const card = cards.get(id);
                return card ? [card] : [];
              })}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
