import { cancelChatRequests } from './chat';
import { cancelCloudTts } from './tts';
import { cancelOfflineTts } from './offlineTts';
import { cancelWhisperTranscriptions } from './providers/WhisperCliProvider';
import { cancelWebRequests } from './webTools';
import { research } from './research';

/** Cancel process-wide asynchronous work that is not owned by a controller instance. */
export function cancelBackgroundWork(): void {
  research.cancel();
  cancelChatRequests();
  cancelCloudTts();
  cancelOfflineTts();
  cancelWhisperTranscriptions();
  cancelWebRequests();
}
