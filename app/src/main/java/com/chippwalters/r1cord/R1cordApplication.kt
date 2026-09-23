package com.chippwalters.r1cord

import android.app.Application
import com.chippwalters.r1cord.recording.PlaybackController
import com.chippwalters.r1cord.recording.RecorderEngine
import com.chippwalters.r1cord.storage.RecordingLibrary
import com.chippwalters.r1cord.sync.OffloadClient
import com.chippwalters.r1cord.sync.UploadCoordinator

class R1cordApplication : Application() {
    lateinit var library: RecordingLibrary
        private set
    lateinit var recorder: RecorderEngine
        private set
    lateinit var playback: PlaybackController
        private set
    lateinit var offloadClient: OffloadClient
        private set
    lateinit var uploadCoordinator: UploadCoordinator
        private set

    override fun onCreate() {
        super.onCreate()
        library = RecordingLibrary(this)
        recorder = RecorderEngine(this, library)
        playback = PlaybackController(this)
        offloadClient = OffloadClient(this)
        uploadCoordinator = UploadCoordinator(this, library, offloadClient)
    }
}
