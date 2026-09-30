import { useWindowDimensions } from 'react-native';
import { Screen } from '@/components/layout/Screen';
import { Modal, ModalBackdrop, ModalContent, ScrollView, VStack } from '@/components/ui';
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
  const { width } = useWindowDimensions();
  const { isDark, resolvedTheme, toggle } = useThemeMode();
  const compact = width < 768;
  const showRail = width >= 1180;

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

  return (
    <Screen statusBarStyle={isDark ? 'light' : 'dark'} safeAreaEdges={['left', 'right', 'top']}>
      <VStack className="flex-1">
        <ChatHeader
          compact={compact}
          isDark={isDark}
          onToggleTheme={toggle}
          onToggleHistory={() => setHistoryOpen(!historyOpen)}
          onNewSession={startNewSession}
          onOpenKnowledgeBuilder={() => router.push('/knowledge-builder')}
          onOpenProblemLogs={() => router.push('/problem-solving-logs')}
        />

        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <VStack className="gap-4 p-4">
            <MessageList
              messages={messages}
              loading={loading}
              colorScheme={resolvedTheme}
              onPrompt={(prompt) => setInput(prompt)}
              onUnderstood={markUnderstood}
            />
            {showRail && (
              <ContextRail
                knowledgeNodes={knowledgeNodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                onPrompt={(prompt) => setInput(prompt)}
                onOpenKnowledgeBase={() => router.push('/knowledge')}
              />
            )}
          </VStack>
        </ScrollView>

        <ChatComposer
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

        <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} size="lg">
          <ModalBackdrop onPress={() => setHistoryOpen(false)} />
          <ModalContent>
            <HistoryPanel
              sessions={sessions}
              onSelect={loadSessionMessages}
              onClose={() => setHistoryOpen(false)}
            />
          </ModalContent>
        </Modal>

        <UploadDialog
          visible={uploadDialogOpen}
          onClose={() => setUploadDialogOpen(false)}
          onSelectImage={selectImage}
          knowledgeNodes={knowledgeNodes}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
      </VStack>
    </Screen>
  );
}
