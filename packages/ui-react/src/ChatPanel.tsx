import type { ReactElement, ReactNode } from "react";

import type { AgentChatViewModel } from "@fadenstack/ui";

import { Composer } from "./Composer.js";
import { ChatHeader } from "./Header.js";
import { useStickToBottom, useViewModel } from "./hooks.js";
import { AgentAvatar } from "./AgentAvatar.js";
import type { PartRenderer } from "./Parts.js";
import { TurnView } from "./Turn.js";

export type ChatTheme = "system" | "light" | "dark";

export interface ChatPanelProps {
  chat: AgentChatViewModel;
  /**
   * `system` (default) follows the browser's light or dark setting as it changes, so the panel looks like
   * part of the browser.
   */
  theme?: ChatTheme;
  /** The host's buttons in the header (settings, sign out). */
  headerExtra?: ReactNode;
  /** The host's controls in the composer (attach the page, the selection). */
  composerAccessory?: ReactNode;
  /** Shown above the composer (e.g. the page the agent works on). */
  contextBar?: ReactNode;
  /** Shown instead of the chat while the agent needs a sign-in. */
  signIn?: ReactNode;
  placeholder?: string;
  /** Views for parts modules add. */
  partRenderers?: readonly PartRenderer[];
  /** A custom agent's own thread colour for its avatar's middle plate. Fadenstack's own agents keep the rose. */
  agentColor?: string;
  /** Replaces the agent's avatar (the Fadenstack stack) in the empty chat, e.g. with the host's own logo. */
  avatar?: ReactNode;
  className?: string;
}

/**
 * A Copilot-style chat with an agent: streamed Markdown, tool lines, approval cards and notices in the order
 * they happened, a tool-mode picker, history, and a composer with context chips. It only renders: everything it
 * shows and does is the view model's, and every text is the chat's `strings` (their `lang` and `dir` too).
 */
export function ChatPanel(props: ChatPanelProps): ReactElement {
  const { chat, theme = "system" } = props;
  useViewModel(chat);
  return (
    <div className={`fdn-chat${props.className ? ` ${props.className}` : ""}`} data-theme={theme} lang={chat.strings.language}
      dir={chat.strings.direction}>
      <ChatHeader chat={chat} extra={props.headerExtra} />
      {chat.signInRequired && props.signIn ? (
        <div className="fdn-body fdn-body-center">{props.signIn}</div>
      ) : (
        <>
          <Conversation {...props} />
          {chat.error && !chat.signInRequired && <div className="fdn-banner" role="alert">{chat.error}</div>}
          {props.contextBar}
          <Composer chat={chat} accessory={props.composerAccessory} placeholder={props.placeholder} />
        </>
      )}
    </div>
  );
}

function Conversation({ chat, partRenderers, agentColor, avatar }: ChatPanelProps): ReactElement {
  const { ref } = useStickToBottom<HTMLDivElement>();
  return (
    <div className="fdn-body" ref={ref} role="log" aria-live="polite" aria-relevant="additions">
      <div className="fdn-turns">
        {chat.isEmpty ? (
          <EmptyState chat={chat} avatar={avatar ?? <AgentAvatar size={64} color={agentColor} />} />
        ) : (
          <>
            {chat.hasEarlierTurns && (
              <button type="button" className="fdn-earlier" onClick={() => chat.loadEarlier()}>{chat.strings.showEarlier}</button>
            )}
            {chat.turns.map((turn) => <TurnView key={turn.key} turn={turn} strings={chat.strings} renderers={partRenderers} />)}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({ chat, avatar }: { chat: AgentChatViewModel; avatar: ReactNode }): ReactElement {
  return (
    <div className="fdn-empty">
      <div className="fdn-empty-mark">{avatar}</div>
      {chat.isReady && <p className="fdn-greeting" dir="auto">{chat.greeting}</p>}
      {chat.suggestions.length > 0 && (
        <div className="fdn-suggestions">
          {chat.suggestions.map((s) => (
            <button key={s} type="button" className="fdn-suggestion" dir="auto" disabled={!chat.isReady || chat.isBusy} onClick={() => void chat.send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
