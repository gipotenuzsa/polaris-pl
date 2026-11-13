import { ChatView } from '../../src/ChatView';
import { useChatWorkspace } from '../../src/ChatWorkspace';

/** Новый разговор создаётся только после отправки первого сообщения. */
export default function Home() {
  const { draftKey } = useChatWorkspace();
  return <ChatView key={draftKey} />;
}
