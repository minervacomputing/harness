import { MessageNotSentError, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { deleteConversation } from '@/api/sdk.gen'
import { type ChatMessage, messageText, pendingMessages, toThreadMessage } from '@/components/chat/model'
import { newSend, SendError, sendMessage } from '@/components/chat/send'
import { errorMessage } from '@/lib/http'
import { useUploadAdapter, type Uploaded } from '@/lib/uploads'

const NONE: ChatMessage[] = []

type Options = {
  workspaceId: string
  /** The conversation's messages; the one being sent is shown after them. */
  messages?: ChatMessage[]
  /**
   * The conversation to send to or, on the new-chat page, how to start one. A conversation started for a
   * message the server refuses is deleted again.
   */
  conversation: string | (() => Promise<string>)
  /** Called once the server has taken the message and the conversation has been refetched. */
  onSent?: (conversationId: string) => unknown
  isRunning?: boolean
  isDisabled?: boolean
  onCancel?: () => Promise<void>
}

/**
 * The thread and composer of a chat page. A message the server refuses goes back to the composer, its files
 * included; any other failure may have started the run, so the message is not given back.
 */
export function useChatRuntime({ workspaceId, messages = NONE, conversation, onSent, isRunning = false, isDisabled, onCancel }: Options) {
  const adapter = useUploadAdapter(workspaceId)
  const send = useMutation(sendMessage)
  const [sending, setSending] = useState<{ content: string; uploads: Uploaded[] }>()
  const shown = useMemo(() => (sending ? [...messages, ...pendingMessages(sending.content, sending.uploads)] : messages), [messages, sending])

  const runtime = useExternalStoreRuntime({
    messages: shown,
    convertMessage: toThreadMessage,
    isRunning: isRunning || !!sending,
    isDisabled,
    adapters: { attachments: adapter },
    onCancel,
    onNew: async message => {
      const content = messageText(message)
      const ids = (message.attachments ?? []).map(attachment => attachment.id)
      const uploads = ids.map(id => adapter.uploaded(id)).filter(upload => upload !== undefined)
      if (!content && uploads.length === 0) return
      const taken = adapter.take(ids)
      setSending({ content, uploads })
      try {
        const started = typeof conversation === 'function'
        const conversationId = started ? await startConversation(conversation) : conversation
        const path = { workspace_id: workspaceId, conversation_id: conversationId }
        try {
          await send.mutateAsync(newSend(path, { content, attachments: uploads.map(upload => upload.id) }))
        } catch (error) {
          if (!(error instanceof SendError && error.refused)) throw error
          // Do not leave an empty chat behind.
          if (started) await deleteConversation({ path, throwOnError: false })
          throw new MessageNotSentError(error.message)
        }
        await onSent?.(conversationId)
      } catch (error) {
        if (error instanceof MessageNotSentError) adapter.restore(taken)
        throw error
      } finally {
        setSending(undefined)
      }
    },
  })

  return { runtime, error: send.error }
}

/** A conversation that could not be started has nothing of the message, so the composer gets it back. */
async function startConversation(start: () => Promise<string>): Promise<string> {
  try {
    return await start()
  } catch (error) {
    throw new MessageNotSentError(errorMessage(error))
  }
}
