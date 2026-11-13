import { useLocalSearchParams } from 'expo-router';
import { ChatView } from '../../src/ChatView';

/** Все разговоры, включая прежний основной, доступны по своей ссылке. */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatView key={id} id={id} />;
}
