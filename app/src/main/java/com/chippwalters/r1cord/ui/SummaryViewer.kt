package com.chippwalters.r1cord.ui

import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * Published pages (the transcript and each AI review) open here, in a WebView, instead of in
 * the device browser: Chrome cannot keep its GPU process alive on the R1, and when it dies
 * Android falls back to the Home app (R1CORD), bouncing the user out of the page.
 * Hardware/gesture Back walks the page history first and then closes the viewer (the
 * activity's BackHandler routes that to model.back()).
 */
@Composable
internal fun SummaryViewer(url: String, model: R1cordViewModel) {
    // A retry after a failed load or a dead renderer gets a brand-new WebView.
    var attempt by remember(url) { mutableIntStateOf(0) }
    var title by remember(url) { mutableStateOf("") }
    var progress by remember(url) { mutableIntStateOf(0) }
    var loading by remember(url) { mutableStateOf(true) }
    var error by remember(url) { mutableStateOf<String?>(null) }
    var canGoBack by remember(url) { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }

    BackHandler(enabled = canGoBack && error == null) { webView?.goBack() }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, webView) {
        val view = webView
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> view?.onPause()
                Lifecycle.Event.ON_RESUME -> view?.onResume()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    fun retry() {
        error = null
        title = ""
        progress = 0
        loading = true
        canGoBack = false
        attempt++
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(Panel).heightIn(min = 56.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = model::back, modifier = control("Close page")) {
                Icon(Icons.Default.Close, null, Modifier.size(28.dp), tint = White)
            }
            Text(
                // An error page's own title ("404 Not Found", "Webpage not available") is noise.
                title.takeIf { error == null }.orEmpty().ifBlank { "SUMMARY" }, fontFamily = RecorderLabelFace, fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
            )
            IconButton(onClick = ::retry, modifier = control("Reload page")) {
                Icon(Icons.Default.Refresh, null, Modifier.size(26.dp), tint = White)
            }
        }
        if (loading && error == null) {
            LinearProgressIndicator(
                progress = { progress / 100f }, color = Orange, trackColor = Recessed,
                modifier = Modifier.fillMaxWidth().height(3.dp),
            )
        } else {
            Spacer(Modifier.fillMaxWidth().height(3.dp).background(Border))
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            key(url, attempt) {
                // A WebView whose renderer died must never be drawn or reused again.
                var rendererGone by remember { mutableStateOf(false) }
                if (!rendererGone) {
                    AndroidView(
                        factory = { context ->
                            WebView(context).apply {
                                setBackgroundColor(Ink.toArgb())
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.allowFileAccess = false
                                settings.allowContentAccess = false
                                settings.builtInZoomControls = true
                                settings.displayZoomControls = false
                                webChromeClient = object : WebChromeClient() {
                                    override fun onProgressChanged(view: WebView, newProgress: Int) { progress = newProgress }
                                    override fun onReceivedTitle(view: WebView, pageTitle: String?) {
                                        // Until <title> is parsed WebView reports the URL; keep the placeholder.
                                        if (!pageTitle.isNullOrBlank() && !pageTitle.startsWith("http")) title = pageTitle
                                    }
                                }
                                webViewClient = object : WebViewClient() {
                                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                                        // Web links stay in this viewer; other schemes (mailto:, intent:…) are ignored.
                                        request.url.scheme?.lowercase() !in setOf("http", "https")

                                    override fun onPageStarted(view: WebView, pageUrl: String?, favicon: Bitmap?) { loading = true }
                                    override fun onPageFinished(view: WebView, pageUrl: String?) { loading = false }
                                    override fun doUpdateVisitedHistory(view: WebView, pageUrl: String?, isReload: Boolean) {
                                        canGoBack = view.canGoBack()
                                    }

                                    override fun onReceivedError(view: WebView, request: WebResourceRequest, err: WebResourceError) {
                                        if (request.isForMainFrame) {
                                            error = "Couldn't reach the page. Check the Wi-Fi connection and try again.\n\n${err.description}"
                                        }
                                    }

                                    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                                        if (!request.isForMainFrame) return
                                        error = if (response.statusCode == 404) {
                                            "This page isn't published yet. It can take a few minutes after sending; try again shortly.\n\nHTTP 404"
                                        } else {
                                            "The server couldn't return the page.\n\nHTTP ${response.statusCode}"
                                        }
                                    }

                                    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, sslError: SslError) {
                                        handler.cancel()
                                        if (sslError.url == view.url || sslError.url == url) {
                                            error = "The page's secure connection failed (certificate error)."
                                        }
                                    }

                                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                                        rendererGone = true
                                        error = "The page stopped unexpectedly. Tap Retry to load it again."
                                        return true
                                    }
                                }
                                loadUrl(url)
                                webView = this
                            }
                        },
                        onRelease = { view ->
                            if (webView === view) webView = null
                            view.stopLoading()
                            view.destroy()
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            error?.let { message ->
                Column(
                    Modifier.fillMaxSize().background(Ink).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Default.CloudOff, null, Modifier.size(56.dp), tint = Orange)
                    Text("COULDN'T LOAD SUMMARY", fontFamily = RecorderDisplayFace, fontSize = 22.sp,
                        fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp, textAlign = TextAlign.Center)
                    Text(message, color = Muted, fontSize = 17.sp, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(4.dp))
                    ActionButton("RETRY", "Retry loading page", Icons.Default.Refresh, ::retry,
                        Modifier.fillMaxWidth(), primary = true)
                    ActionButton("CLOSE", "Close page", Icons.Default.Close, model::back, Modifier.fillMaxWidth())
                }
            }
        }
    }
}
