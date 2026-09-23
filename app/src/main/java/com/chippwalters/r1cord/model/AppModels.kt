package com.chippwalters.r1cord.model

/**
 * Live capture state. AUTO_LISTENING is voice-activated pausing in its gated phase: the
 * microphone is still live and the level meter still moves, but no audio is being committed
 * and recorded time is frozen. It counts as capturing (see AppUiState.isCapturing) and is
 * distinct from PAUSED, which is a user decision speech must never override.
 */
enum class CaptureStatus { IDLE, STARTING, RECORDING, AUTO_LISTENING, PAUSED, STOPPING }
data class PhotoItem(val id: String, val uri: String, val createdAt: Long)

/** AI reviews the desktop server can write for a recording, in canonical order. */
val REVIEW_KINDS = listOf("summary", "outline", "organized")

/** Published page kinds in canonical (display) order: the transcript page, then one per review. */
val PAGE_KINDS = listOf("transcript") + REVIEW_KINDS

/** One page the desktop server published for a recording. */
data class PublishedPage(val kind: String, val url: String)

/**
 * The pages of a recording from a server response. [pages] is null when the server sent none
 * (servers before AI reviews): its single [webdavUrl] is then the one page. Those servers only
 * publish `summary.html`; a newer server's predicted `<kind>.html` link keeps its own kind.
 */
fun resolvePages(pages: List<PublishedPage>?, webdavUrl: String?): List<PublishedPage> {
    if (pages != null) return pages.filter { it.kind in PAGE_KINDS }.distinctBy { it.kind }.sortedBy { PAGE_KINDS.indexOf(it.kind) }
    val url = webdavUrl?.takeIf { it.isNotBlank() } ?: return emptyList()
    val named = url.substringBefore('?').substringAfterLast('/').removeSuffix(".html")
    return listOf(PublishedPage(if (named in PAGE_KINDS) named else "summary", url))
}

/** The page "Open" shows after a send: the Summary page if there is one, else the first page. */
fun List<PublishedPage>.primaryPage(): PublishedPage? = firstOrNull { it.kind == "summary" } ?: firstOrNull()

data class RecordingItem(
    val id: String,
    val title: String,
    val createdAt: Long,
    val durationMs: Long = 0,
    val audioUri: String = "",
    val status: String = "RECORDING",
    val photos: List<PhotoItem> = emptyList(),
    val waveform: List<Float> = emptyList(),
    val jobId: String? = null,
    val jobStatus: String = "local",
    /** Published pages in canonical order; empty until the server reports any. */
    val pages: List<PublishedPage> = emptyList(),
)
data class CaptureState(
    val recordingId: String? = null,
    val status: CaptureStatus = CaptureStatus.IDLE,
    val elapsedMs: Long = 0,
    val level: Float = 0f,
    val error: String? = null,
    val lastCompletedId: String? = null,
)
data class PlaybackState(
    val recordingId: String? = null,
    val isPlaying: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val error: String? = null,
)
enum class Screen { HOME, RECORDING, LIBRARY, DETAIL, CAMERA, VIEWER }
data class UploadUiState(
    val recordingId: String,
    val fileIndex: Int,
    val fileCount: Int,
    val bytesSent: Long,
    val bytesTotal: Long,
    val phase: String,
)
data class SendResultUi(val recordingId: String, val pageUrl: String?)
data class PairingUiState(
    val busy: Boolean = false,
    val error: String? = null,
    val serverName: String? = null,
)
data class AppUiState(
    val screen: Screen = Screen.HOME,
    val capture: CaptureState = CaptureState(),
    val recordings: List<RecordingItem> = emptyList(),
    val playback: PlaybackState = PlaybackState(),
    val selectedId: String? = null,
    val storageSeconds: Long = 0,
    val batteryPercent: Int = 0,
    val isCharging: Boolean = false,
    val volume: Int = 1,
    val volumeMax: Int = 15,
    val message: String? = null,
    val sendSheetFor: String? = null,
    val upload: UploadUiState? = null,
    val sendResult: SendResultUi? = null,
    val refreshing: Boolean = false,
    val pairing: PairingUiState? = null,
    val paired: Boolean = false,
    val serverName: String = "",
    /** Published page shown by the in-app viewer (Screen.VIEWER). */
    val viewerUrl: String? = null,
) {
    val selected: RecordingItem? get() = recordings.firstOrNull { it.id == selectedId }
    val isCapturing: Boolean get() = capture.status != CaptureStatus.IDLE
}
