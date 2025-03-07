import _ from 'lodash'
import charset from 'charset'
import type Debug from 'debug'
import type { CookieOptions } from 'express'
import { cors, concatStream, httpUtils } from '@packages/network'
import type { CypressIncomingRequest, CypressOutgoingResponse } from '@packages/proxy'
import type { HttpMiddleware, HttpMiddlewareThis } from '.'
import iconv from 'iconv-lite'
import type { IncomingMessage, IncomingHttpHeaders } from 'http'
import { InterceptResponse } from '@packages/net-stubbing'
import { PassThrough, Readable } from 'stream'
import * as rewriter from './util/rewriter'
import zlib from 'zlib'
import { URL } from 'url'
import { CookiesHelper } from './util/cookies'
import { doesTopNeedToBeSimulated } from './util/top-simulation'
import { toughCookieToAutomationCookie } from '@packages/server/lib/util/cookies'

interface ResponseMiddlewareProps {
  /**
   * Before using `res.incomingResStream`, `prepareResStream` can be used
   * to remove any encoding that prevents it from being returned as plain text.
   *
   * This is done as-needed to avoid unnecessary g(un)zipping.
   */
  makeResStreamPlainText: () => void
  isGunzipped: boolean
  incomingRes: IncomingMessage
  incomingResStream: Readable
}

export type ResponseMiddleware = HttpMiddleware<ResponseMiddlewareProps>

// do not use a debug namespace in this file - use the per-request `this.debug` instead
// available as cypress-verbose:proxy:http
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const debug = null

// https://github.com/cypress-io/cypress/issues/1756
const zlibOptions = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH,
}

// https://github.com/cypress-io/cypress/issues/1543
function getNodeCharsetFromResponse (headers: IncomingHttpHeaders, body: Buffer, debug: Debug.Debugger) {
  const httpCharset = (charset(headers, body, 1024) || '').toLowerCase()

  debug('inferred charset from response %o', { httpCharset })
  if (iconv.encodingExists(httpCharset)) {
    return httpCharset
  }

  // browsers default to latin1
  return 'latin1'
}

function reqMatchesPolicyBasedOnDomain (req: CypressIncomingRequest, remoteState) {
  if (remoteState.strategy === 'http') {
    return cors.urlMatchesPolicyBasedOnDomainProps(req.proxiedUrl, remoteState.props)
  }

  if (remoteState.strategy === 'file') {
    return req.proxiedUrl.startsWith(remoteState.origin)
  }

  return false
}

function reqWillRenderHtml (req: CypressIncomingRequest, res: IncomingMessage) {
  // will this request be rendered in the browser, necessitating injection?
  // https://github.com/cypress-io/cypress/issues/288

  // don't inject if this is an XHR from jquery
  if (req.headers['x-requested-with']) {
    return
  }

  // don't inject if we didn't find both text/html and application/xhtml+xml,
  const accept = req.headers['accept']

  // only check the content-type value, if it exists, to contains some type of html mimetype
  const contentType = res?.headers['content-type'] || ''
  const contentTypeIsHtmlIfExists = contentType ? contentType.includes('html') : true

  return accept && accept.includes('text/html') && accept.includes('application/xhtml+xml') && contentTypeIsHtmlIfExists
}

function resContentTypeIs (res: IncomingMessage, contentType: string) {
  return (res.headers['content-type'] || '').includes(contentType)
}

function resContentTypeIsJavaScript (res: IncomingMessage) {
  return _.some(
    ['application/javascript', 'application/x-javascript', 'text/javascript']
    .map(_.partial(resContentTypeIs, res)),
  )
}

function resIsGzipped (res: IncomingMessage) {
  return (res.headers['content-encoding'] || '').includes('gzip')
}

function setCookie (res: CypressOutgoingResponse, k: string, v: string, domain: string) {
  let opts: CookieOptions = { domain }

  if (!v) {
    v = ''

    opts.expires = new Date(0)
  }

  return res.cookie(k, v, opts)
}

function setInitialCookie (res: CypressOutgoingResponse, remoteState: any, value) {
  // dont modify any cookies if we're trying to clear the initial cookie and we're not injecting anything
  // dont set the cookies if we're not on the initial request
  if ((!value && !res.wantsInjection) || !res.isInitial) {
    return
  }

  return setCookie(res, '__cypress.initial', value, remoteState.domainName)
}

// "autoplay *; document-domain 'none'" => { autoplay: "*", "document-domain": "'none'" }
const parseFeaturePolicy = (policy: string): any => {
  const pairs = policy.split('; ').map((directive) => directive.split(' '))

  return _.fromPairs(pairs)
}

// { autoplay: "*", "document-domain": "'none'" } => "autoplay *; document-domain 'none'"
const stringifyFeaturePolicy = (policy: any): string => {
  const pairs = _.toPairs(policy)

  return pairs.map((directive) => directive.join(' ')).join('; ')
}

const LogResponse: ResponseMiddleware = function () {
  this.debug('received response %o', {
    req: _.pick(this.req, 'method', 'proxiedUrl', 'headers'),
    incomingRes: _.pick(this.incomingRes, 'headers', 'statusCode'),
  })

  this.next()
}

const AttachPlainTextStreamFn: ResponseMiddleware = function () {
  this.makeResStreamPlainText = function () {
    this.debug('ensuring resStream is plaintext')

    if (!this.isGunzipped && resIsGzipped(this.incomingRes)) {
      this.debug('gunzipping response body')

      const gunzip = zlib.createGunzip(zlibOptions)

      this.incomingResStream = this.incomingResStream.pipe(gunzip).on('error', this.onError)

      this.isGunzipped = true
    }
  }

  this.next()
}

const PatchExpressSetHeader: ResponseMiddleware = function () {
  const { incomingRes } = this
  const originalSetHeader = this.res.setHeader

  // Node uses their own Symbol object, so use this to get the internal kOutHeaders
  // symbol - Symbol.for('kOutHeaders') will not work
  const getKOutHeadersSymbol = () => {
    const findKOutHeadersSymbol = (): symbol => {
      return _.find(Object.getOwnPropertySymbols(this.res), (sym) => {
        return sym.toString() === 'Symbol(kOutHeaders)'
      })!
    }

    let sym = findKOutHeadersSymbol()

    if (sym) {
      return sym
    }

    // force creation of a new header field so the kOutHeaders key is available
    this.res.setHeader('X-Cypress-HTTP-Response', 'X')
    this.res.removeHeader('X-Cypress-HTTP-Response')

    sym = findKOutHeadersSymbol()

    if (!sym) {
      throw new Error('unable to find kOutHeaders symbol')
    }

    return sym
  }

  let kOutHeaders

  const ctxDebug = this.debug

  this.res.setHeader = function (name, value) {
    // express.Response.setHeader does all kinds of silly/nasty stuff to the content-type...
    // but we don't want to change it at all!
    if (name === 'content-type') {
      value = incomingRes.headers['content-type'] || value
    }

    // run the original function - if an "invalid header char" error is raised,
    // set the header manually. this way we can retain Node's original error behavior
    try {
      return originalSetHeader.call(this, name, value)
    } catch (err: any) {
      if (err.code !== 'ERR_INVALID_CHAR') {
        throw err
      }

      ctxDebug('setHeader error ignored %o', { name, value, code: err.code, err })

      if (!kOutHeaders) {
        kOutHeaders = getKOutHeadersSymbol()
      }

      // https://github.com/nodejs/node/blob/42cce5a9d0fd905bf4ad7a2528c36572dfb8b5ad/lib/_http_outgoing.js#L483-L495
      let headers = this[kOutHeaders]

      if (!headers) {
        this[kOutHeaders] = headers = Object.create(null)
      }

      headers[name.toLowerCase()] = [name, value]
    }
  }

  this.next()
}

const SetInjectionLevel: ResponseMiddleware = function () {
  this.res.isInitial = this.req.cookies['__cypress.initial'] === 'true'

  const isHTML = resContentTypeIs(this.incomingRes, 'text/html')
  const isRenderedHTML = reqWillRenderHtml(this.req, this.incomingRes)

  if (isRenderedHTML) {
    const origin = new URL(this.req.proxiedUrl).origin

    this.getRenderedHTMLOrigins()[origin] = true
  }

  this.debug('determine injection')

  const isReqMatchSuperDomainOrigin = reqMatchesPolicyBasedOnDomain(this.req, this.remoteStates.current())
  const getInjectionLevel = () => {
    if (this.incomingRes.headers['x-cypress-file-server-error'] && !this.res.isInitial) {
      this.debug('- partial injection (x-cypress-file-server-error)')

      return 'partial'
    }

    // NOTE: Only inject fullCrossOrigin if the super domain origins do not match in order to keep parity with cypress application reloads
    const urlDoesNotMatchPolicyBasedOnDomain = !reqMatchesPolicyBasedOnDomain(this.req, this.remoteStates.getPrimary())
    const isAUTFrame = this.req.isAUTFrame
    const isHTMLLike = isHTML || isRenderedHTML

    if (urlDoesNotMatchPolicyBasedOnDomain && isAUTFrame && isHTMLLike) {
      this.debug('- cross origin injection')

      return 'fullCrossOrigin'
    }

    if (!isHTML || (!isReqMatchSuperDomainOrigin && !isAUTFrame)) {
      this.debug('- no injection (not html)')

      return false
    }

    if (this.res.isInitial && isHTMLLike) {
      this.debug('- full injection')

      return 'full'
    }

    if (!isRenderedHTML) {
      this.debug('- no injection (not rendered html)')

      return false
    }

    this.debug('- partial injection (default)')

    return 'partial'
  }

  if (this.res.wantsInjection != null) {
    this.debug('- already has injection: %s', this.res.wantsInjection)
  }

  if (this.res.wantsInjection == null) {
    this.res.wantsInjection = getInjectionLevel()
  }

  if (this.res.wantsInjection) {
    // Chrome plans to make document.domain immutable in Chrome 106, with the default value
    // of the Origin-Agent-Cluster header becoming 'true'. We explicitly disable this header
    // so that we can continue to support tests that visit multiple subdomains in a single spec.
    // https://github.com/cypress-io/cypress/issues/20147
    //
    // We set the header here only for proxied requests that have scripts injected that set the domain.
    // Other proxied requests are ignored.
    this.res.setHeader('Origin-Agent-Cluster', '?0')
  }

  this.res.wantsSecurityRemoved = (this.config.modifyObstructiveCode || this.config.experimentalModifyObstructiveThirdPartyCode) &&
    // if experimentalModifyObstructiveThirdPartyCode is enabled, we want to modify all framebusting code that is html or javascript that passes through the proxy
    ((this.config.experimentalModifyObstructiveThirdPartyCode
      && (isHTML || isRenderedHTML || resContentTypeIsJavaScript(this.incomingRes))) ||
     this.res.wantsInjection === 'full' ||
     this.res.wantsInjection === 'fullCrossOrigin' ||
     // only modify JavasScript if matching the current origin policy or if experimentalModifyObstructiveThirdPartyCode is enabled (above)
     (resContentTypeIsJavaScript(this.incomingRes) && isReqMatchSuperDomainOrigin))

  this.debug('injection levels: %o', _.pick(this.res, 'isInitial', 'wantsInjection', 'wantsSecurityRemoved'))

  this.next()
}

// https://github.com/cypress-io/cypress/issues/6480
const MaybeStripDocumentDomainFeaturePolicy: ResponseMiddleware = function () {
  const { 'feature-policy': featurePolicy } = this.incomingRes.headers

  if (featurePolicy) {
    const directives = parseFeaturePolicy(<string>featurePolicy)

    if (directives['document-domain']) {
      delete directives['document-domain']

      const policy = stringifyFeaturePolicy(directives)

      if (policy) {
        this.res.set('feature-policy', policy)
      } else {
        this.res.removeHeader('feature-policy')
      }
    }
  }

  this.next()
}

const OmitProblematicHeaders: ResponseMiddleware = function () {
  const headers = _.omit(this.incomingRes.headers, [
    'set-cookie',
    'x-frame-options',
    'content-length',
    'transfer-encoding',
    'content-security-policy',
    'content-security-policy-report-only',
    'connection',
  ])

  this.res.set(headers)

  this.next()
}

const MaybePreventCaching: ResponseMiddleware = function () {
  // do not cache injected responses
  // TODO: consider implementing etag system so even injected content can be cached
  if (this.res.wantsInjection) {
    this.res.setHeader('cache-control', 'no-cache, no-store, must-revalidate')
  }

  this.next()
}

const setSimulatedCookies = (ctx: HttpMiddlewareThis<ResponseMiddlewareProps>) => {
  if (ctx.res.wantsInjection !== 'fullCrossOrigin') return

  const defaultDomain = (new URL(ctx.req.proxiedUrl)).hostname
  const allCookiesForRequest = ctx.getCookieJar()
  .getCookies(ctx.req.proxiedUrl)
  .map((cookie) => toughCookieToAutomationCookie(cookie, defaultDomain))

  ctx.simulatedCookies = allCookiesForRequest
}

const MaybeCopyCookiesFromIncomingRes: ResponseMiddleware = async function () {
  const cookies: string | string[] | undefined = this.incomingRes.headers['set-cookie']

  if (!cookies || !cookies.length) {
    setSimulatedCookies(this)

    return this.next()
  }

  // Simulated Top Cookie Handling
  // ---------------------------
  // - We capture cookies sent by responses and add them to our own server-side
  //   tough-cookie cookie jar. All request cookies are captured, since any
  //   future request could be cross-origin in the context of top, even if the response that sets them
  //   is not.
  // - If we sent the cookie header, it may fail to be set by the browser
  //   (in most cases). However, we cannot determine all the cases in which Set-Cookie
  //   will currently fail. We try to address this in our tough cookie jar
  //   by only setting cookies that would otherwise work in the browser if the AUT url was top
  // - We also set the cookies through automation so they are available in the
  //   browser via document.cookie and via Cypress cookie APIs
  //   (e.g. cy.getCookie). This is only done when the AUT url and top do not match responses,
  //   since AUT and Top being same origin will be successfully set in the browser
  //   automatically as expected.
  // - In the request middleware, we retrieve the cookies for a given URL
  //   and attach them to the request, like the browser normally would.
  //   tough-cookie handles retrieving the correct cookies based on domain,
  //   path, etc. It also removes cookies from the cookie jar if they've expired.
  const doesTopNeedSimulating = doesTopNeedToBeSimulated(this)

  const appendCookie = (cookie: string) => {
    // always call 'Set-Cookie' in the browser as cross origin or same site requests
    // can effectively set cookies in the browser if given correct credential permissions
    const headerName = 'Set-Cookie'

    try {
      this.res.append(headerName, cookie)
    } catch (err) {
      this.debug(`failed to append header ${headerName}, continuing %o`, { err, cookie })
    }
  }

  if (!doesTopNeedSimulating) {
    ([] as string[]).concat(cookies).forEach((cookie) => {
      appendCookie(cookie)
    })

    return this.next()
  }

  const cookiesHelper = new CookiesHelper({
    cookieJar: this.getCookieJar(),
    currentAUTUrl: this.getAUTUrl(),
    debug: this.debug,
    request: {
      url: this.req.proxiedUrl,
      isAUTFrame: this.req.isAUTFrame,
      doesTopNeedSimulating,
      resourceType: this.req.requestedWith,
      credentialLevel: this.req.credentialsLevel,
    },
  })

  await cookiesHelper.capturePreviousCookies()

  ;([] as string[]).concat(cookies).forEach((cookie) => {
    cookiesHelper.setCookie(cookie)

    appendCookie(cookie)
  })

  setSimulatedCookies(this)

  const addedCookies = await cookiesHelper.getAddedCookies()

  if (!addedCookies.length) {
    return this.next()
  }

  // we want to set the cookies via automation so they exist in the browser
  // itself. however, firefox will hang if we try to use the extension
  // to set cookies on a url that's in-flight, so we send the cookies down to
  // the driver, let the response go, and set the cookies via automation
  // from the driver once the page has loaded but before we run any further
  // commands
  this.serverBus.once('cross:origin:cookies:received', () => {
    this.next()
  })

  this.serverBus.emit('cross:origin:cookies', addedCookies)
}

const REDIRECT_STATUS_CODES: any[] = [301, 302, 303, 307, 308]

// TODO: this shouldn't really even be necessary?
const MaybeSendRedirectToClient: ResponseMiddleware = function () {
  const { statusCode, headers } = this.incomingRes
  const newUrl = headers['location']

  if (!REDIRECT_STATUS_CODES.includes(statusCode) || !newUrl) {
    return this.next()
  }

  setInitialCookie(this.res, this.remoteStates.current(), true)

  this.debug('redirecting to new url %o', { statusCode, newUrl })
  this.res.redirect(Number(statusCode), newUrl)

  return this.end()
}

const CopyResponseStatusCode: ResponseMiddleware = function () {
  this.res.status(Number(this.incomingRes.statusCode))
  // Set custom status message/reason phrase from http response
  // https://github.com/cypress-io/cypress/issues/16973
  if (this.incomingRes.statusMessage) {
    this.res.statusMessage = this.incomingRes.statusMessage
  }

  this.next()
}

const ClearCyInitialCookie: ResponseMiddleware = function () {
  setInitialCookie(this.res, this.remoteStates.current(), false)
  this.next()
}

const MaybeEndWithEmptyBody: ResponseMiddleware = function () {
  if (httpUtils.responseMustHaveEmptyBody(this.req, this.incomingRes)) {
    this.res.end()

    return this.end()
  }

  this.next()
}

const MaybeInjectHtml: ResponseMiddleware = function () {
  if (!this.res.wantsInjection) {
    return this.next()
  }

  this.skipMiddleware('MaybeRemoveSecurity') // we only want to do one or the other

  this.debug('injecting into HTML')

  this.makeResStreamPlainText()

  this.incomingResStream.pipe(concatStream(async (body) => {
    const nodeCharset = getNodeCharsetFromResponse(this.incomingRes.headers, body, this.debug)

    const decodedBody = iconv.decode(body, nodeCharset)
    const injectedBody = await rewriter.html(decodedBody, {
      domainName: cors.getDomainNameFromUrl(this.req.proxiedUrl),
      wantsInjection: this.res.wantsInjection,
      wantsSecurityRemoved: this.res.wantsSecurityRemoved,
      isNotJavascript: !resContentTypeIsJavaScript(this.incomingRes),
      useAstSourceRewriting: this.config.experimentalSourceRewriting,
      modifyObstructiveThirdPartyCode: this.config.experimentalModifyObstructiveThirdPartyCode && !this.remoteStates.isPrimarySuperDomainOrigin(this.req.proxiedUrl),
      modifyObstructiveCode: this.config.modifyObstructiveCode,
      url: this.req.proxiedUrl,
      deferSourceMapRewrite: this.deferSourceMapRewrite,
      simulatedCookies: this.simulatedCookies,
    })
    const encodedBody = iconv.encode(injectedBody, nodeCharset)

    const pt = new PassThrough

    pt.write(encodedBody)
    pt.end()

    this.incomingResStream = pt
    this.next()
  })).on('error', this.onError)
}

const MaybeRemoveSecurity: ResponseMiddleware = function () {
  if (!this.res.wantsSecurityRemoved) {
    return this.next()
  }

  this.debug('removing JS framebusting code')

  this.makeResStreamPlainText()

  this.incomingResStream.setEncoding('utf8')
  this.incomingResStream = this.incomingResStream.pipe(rewriter.security({
    isNotJavascript: !resContentTypeIsJavaScript(this.incomingRes),
    useAstSourceRewriting: this.config.experimentalSourceRewriting,
    modifyObstructiveThirdPartyCode: this.config.experimentalModifyObstructiveThirdPartyCode && !this.remoteStates.isPrimarySuperDomainOrigin(this.req.proxiedUrl),
    modifyObstructiveCode: this.config.modifyObstructiveCode,
    url: this.req.proxiedUrl,
    deferSourceMapRewrite: this.deferSourceMapRewrite,
  })).on('error', this.onError)

  this.next()
}

const GzipBody: ResponseMiddleware = function () {
  if (this.isGunzipped) {
    this.debug('regzipping response body')
    this.incomingResStream = this.incomingResStream.pipe(zlib.createGzip(zlibOptions)).on('error', this.onError)
  }

  this.next()
}

const SendResponseBodyToClient: ResponseMiddleware = function () {
  if (this.req.isAUTFrame) {
    // track the previous AUT request URL so we know if the next requests
    // is cross-origin
    this.setAUTUrl(this.req.proxiedUrl)
  }

  this.incomingResStream.pipe(this.res).on('error', this.onError)
  this.res.on('end', () => this.end())
}

export default {
  LogResponse,
  AttachPlainTextStreamFn,
  InterceptResponse,
  PatchExpressSetHeader,
  SetInjectionLevel,
  OmitProblematicHeaders,
  MaybePreventCaching,
  MaybeStripDocumentDomainFeaturePolicy,
  MaybeCopyCookiesFromIncomingRes,
  MaybeSendRedirectToClient,
  CopyResponseStatusCode,
  ClearCyInitialCookie,
  MaybeEndWithEmptyBody,
  MaybeInjectHtml,
  MaybeRemoveSecurity,
  GzipBody,
  SendResponseBodyToClient,
}
