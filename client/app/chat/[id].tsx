import { useLocalSearchParams } from 'expo-router';
import { ChatView } from '../../src/ChatView';

/** Отдельная тема из архива (главный разговор — на первой вкладке). */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatView key={id} id={id} />;
}
