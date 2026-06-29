import { Context, Effect, Layer, type Stream, SubscriptionRef } from "effect"
import { nowIso } from "../clock.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Chat } from "../../shared/chat.js"
import { ArcStore } from "../db/store.js"
import type { ChatRow } from "../db/schema.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { newArcId, type WorkspaceId } from "../../shared/ids.js"

/**
 * Owns the set of chats — the conversation threads target sessions belong to.
 * Backed by a SubscriptionRef so the list is reactive (the renderer mirrors it
 * through an atom, same as sessions). Creates are durable-first: SQLite must
 * accept the row before the in-memory list updates.
 */
export class ChatService extends Context.Service<
  ChatService,
  {
    readonly list: Effect.Effect<ReadonlyArray<Chat>>
    /** A single chat by id, or {@link ArcRequestError} if unknown. */
    readonly get: (id: string) => Effect.Effect<Chat, ArcRequestError>
    readonly changes: Stream.Stream<ReadonlyArray<Chat>>
    readonly create: (
      workspaceId: WorkspaceId,
      title?: string,
    ) => Effect.Effect<Chat, ArcRequestError | SqlError>
    readonly updateTitleIfDefault: (
      chatId: string,
      title: string,
    ) => Effect.Effect<boolean, SqlError>
    readonly updateTitle: (
      chatId: string,
      title: string,
    ) => Effect.Effect<Chat, ArcRequestError | SqlError>
  }
>()("ChatService") {}

const rowToChat = (r: ChatRow): Chat => ({
  _tag: "Chat",
  id: r.id,
  workspaceId: r.workspaceId,
  title: r.title,
  createdAt: r.createdAt,
})

export const ChatServiceLive = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const db = yield* ArcStore

    // Restore persisted chats on boot; a load failure starts empty (logged).
    const rows = yield* db.loadChats.pipe(
      Effect.tapError((e) => Effect.logWarning(`chat load failed; starting empty: ${e}`)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<ChatRow>),
    )
    const initial: ReadonlyArray<Chat> = rows.map(rowToChat)

    const store = yield* SubscriptionRef.make(initial)

    const list = SubscriptionRef.get(store)
    const get = (id: string): Effect.Effect<Chat, ArcRequestError> =>
      Effect.flatMap(list, (all) => {
        const chat = all.find((c) => c.id === id)
        return chat ? Effect.succeed(chat) : Effect.fail(arcRequestError(`Unknown chat "${id}"`))
      })
    const changes = SubscriptionRef.changes(store)

    const create = Effect.fn("ChatService.create")((workspaceId: WorkspaceId, title?: string) =>
      Effect.gen(function* () {
        const exists = yield* db.workspaceExists(workspaceId)
        if (!exists) {
          return yield* Effect.fail(arcRequestError(`Unknown workspace "${workspaceId}"`))
        }

        const chat: Chat = {
          _tag: "Chat",
          id: newArcId("chat"),
          workspaceId,
          title: title?.trim() || "new chat",
          createdAt: yield* nowIso,
        }
        yield* db.insertChat({
          id: chat.id,
          workspaceId: chat.workspaceId,
          title: chat.title,
          createdAt: chat.createdAt,
        })
        yield* SubscriptionRef.update(store, (chats) => [...chats, chat])
        return chat
      }).pipe(
        Effect.withSpan("arc.chat.create", {
          attributes: {
            "arc.workspace_id": workspaceId,
            "arc.chat_title_provided": Boolean(title?.trim()),
          },
        }),
      ),
    )

    const updateTitleIfDefault = Effect.fn("ChatService.updateTitleIfDefault")((chatId: string, title: string) =>
      Effect.gen(function* () {
        const trimmed = title.trim()
        if (trimmed.length === 0) return false

        const current = (yield* SubscriptionRef.get(store)).find((chat) => chat.id === chatId)
        if (!current || current.title !== "new chat") return false

        const changed = yield* db.updateChatTitle(chatId, trimmed)
        if (!changed) return false

        yield* SubscriptionRef.update(store, (chats) =>
          chats.map((chat) => chat.id === chatId ? { ...chat, title: trimmed } : chat),
        )
        return true
      }),
    )

    const updateTitle = Effect.fn("ChatService.updateTitle")((chatId: string, title: string) =>
      Effect.gen(function* () {
        const trimmed = title.trim()
        if (trimmed.length === 0) {
          return yield* Effect.fail(arcRequestError("Chat title cannot be empty"))
        }

        const current = yield* get(chatId)
        if (current.title === trimmed) return current

        const changed = yield* db.updateChatTitle(chatId, trimmed)
        if (!changed) {
          return yield* Effect.fail(arcRequestError(`Unknown chat "${chatId}"`))
        }

        const updated = { ...current, title: trimmed }
        yield* SubscriptionRef.update(store, (chats) =>
          chats.map((chat) => chat.id === chatId ? updated : chat),
        )
        return updated
      }).pipe(
        Effect.withSpan("arc.chat.update_title", {
          attributes: { "arc.chat_id": chatId },
        }),
      ),
    )

    return { list, get, changes, create, updateTitleIfDefault, updateTitle }
  }),
)
