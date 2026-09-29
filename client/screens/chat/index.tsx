import { View, useWindowDimensions } from 'react-native';
import { Modal, Portal, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useThemeMode } from '@/contexts/ThemeModeContext';
import { useChatWorkspace } from './hooks/useChatWorkspace';
import ChatHeader from './components/ChatHeader';
import ChatComposer from './components/ChatComposer';
import ContextRail from './components/ContextRail';
import HistoryPanel from './components/HistoryPanel';
import MessageList from './components/MessageList';
import UploadDialog from './components/UploadDialog';

export default function ChatScreen() {
  const router = useSafeRouter();
  const theme = useTheme<MD3Theme>();
  const { width } = useWindowDimensions();
  const { isDark, resolvedTheme, toggle } = useThemeMode();
  const compact = width < 768;
  const showRail = width >= 1180;
  const showDockedHistory = width >= 1024;

  const workspace = useChatWorkspace();
  const {
    messages,
    sessions,
    knowledgeNodes,
    input,
    setInput,
    loading,
    historyOpen,
    setHistoryOpen,
    uploadDialogOpen,
    setUploadDialogOpen,
    uploadFile,
    setUploadFile,
    selectedNodeId,
    setSelectedNodeId,
    loadSessionMessages,
    startNewSession,
    submitMessage,
    markUnderstood,
    selectImage,
  } = workspace;

  const historyPanel = (
    <HistoryPanel
      sessions={sessions}
      onSelect={loadSessionMessages}
      onClose={() => setHistoryOpen(false)}
    />
  );

  return (
    <Screen
      statusBarStyle={isDark ? 'light' : 'dark'}
      safeAreaEdges={['left', 'right', 'top']}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
        }}
      >
        <ChatHeader
          compact={compact}
          isDark={isDark}
          onToggleTheme={toggle}
          onToggleHistory={() => setHistoryOpen(!historyOpen)}
          onNewSession={startNewSession}
          onOpenKnowledgeBuilder={() => router.push('/knowledge-builder')}
          onOpenProblemLogs={() => router.push('/problem-solving-logs')}
        />

        <View style={{ flex: 1, flexDirection: 'row' }}>
          {showDockedHistory && historyOpen && historyPanel}

          <View style={{ flex: 1, minWidth: 0 }}>
            <MessageList
              messages={messages}
              loading={loading}
              colorScheme={resolvedTheme}
              onPrompt={(prompt) => setInput(prompt)}
              onUnderstood={markUnderstood}
            />

            <ChatComposer
              compact={compact}
              value={input}
              onChange={setInput}
              onSubmit={() => submitMessage()}
              loading={loading}
              uploadFile={uploadFile}
              onRemoveUpload={() => setUploadFile(null)}
              onOpenUpload={() => setUploadDialogOpen(true)}
              knowledgeNodes={knowledgeNodes}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
            />
          </View>

          {showRail && (
            <ContextRail
              knowledgeNodes={knowledgeNodes}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onPrompt={(prompt) => setInput(prompt)}
              onOpenKnowledgeBase={() => router.push('/knowledge')}
            />
          )}
        </View>

        {!showDockedHistory && (
          <Portal>
            <Modal
              visible={historyOpen}
              onDismiss={() => setHistoryOpen(false)}
              contentContainerStyle={{
                flex: 1,
                justifyContent: 'flex-start',
                alignItems: 'flex-start',
              }}
            >
              {historyPanel}
            </Modal>
          </Portal>
        )}

        <UploadDialog
          compact={compact}
          visible={uploadDialogOpen}
          onClose={() => setUploadDialogOpen(false)}
          onSelectImage={selectImage}
          knowledgeNodes={knowledgeNodes}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
      </View>
    </Screen>
  );
}
