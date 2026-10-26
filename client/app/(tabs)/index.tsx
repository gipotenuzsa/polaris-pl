import { api } from '../../src/api';
import { ChatView } from '../../src/ChatView';
import { useLoad } from '../../src/hooks';
import { ErrorNote, Loading, Screen } from '../../src/ui';

/** Главная вкладка: единый сквозной разговор с Polaris — без переключения чатов. */
export default function Home() {
  const { data, error, refresh } = useLoad(() => api.main());
  if (!data) {
    return (
      <Screen edges={['left', 'right']}>
        <ErrorNote message={error} onRetry={refresh} />
        {error ? null : <Loading />}
      </Screen>
    );
  }
  return <ChatView key={data.conversation.id} id={data.conversation.id} main />;
}
