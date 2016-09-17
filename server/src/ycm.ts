import * as net from 'net'
import * as crypto from 'crypto'
import * as childProcess from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as _ from 'lodash'
import * as http from 'http'
import * as url from 'url'
import * as qs from 'querystring'
import * as rp from 'request-promise'

import {
    mapYcmCompletionsToLanguageServerCompletions,
    mapYcmDiagnosticToLanguageServerDiagnostic,
    crossPlatformBufferToString,
    logger,
    crossPlatformUri,
    mapYcmTypeToHover,
    mapYcmLocationToLocation
} from './utils'

import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection, TextDocumentSyncKind,
    TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
    InitializeParams, InitializeResult, TextDocumentPositionParams,
    CompletionItem, CompletionItemKind, Position, Location, RemoteWindow,
    MessageActionItem
} from 'vscode-languageserver'

import YcmRequest from './ycmRequest'

export default class Ycm {
    private port: number
    private hmacSecret: Buffer
    private process: childProcess.ChildProcess
    private workingDir: string
    private window: RemoteWindow

    private settings: Settings

    private constructor(settings: Settings) {
        this.settings = settings
    }

    private findUnusedPort(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const server = net.createServer()
            server.listen(0, () => {
                resolve(server.address().port)
                server.close()
            })
            server.on('error', (err) => reject(err))
        })
    }

    private readDefaultOptions() {
        return new Promise<any>((resolve, reject) => {
            fs.readFile(path.resolve(this.settings.ycmd.path, 'ycmd', 'default_settings.json'), {encoding: 'utf8'}, (err, data) => {
                if (err) reject(err)
                else resolve(JSON.parse(data))
            })
        })
    }

    private generateRandomSecret(): Buffer {
        return crypto.randomBytes(16)
    }

    private processData([unusedPort, hmac, options]: [number, Buffer, any]): Promise<string> {
        this.port = unusedPort
        this.hmacSecret = hmac
        options.hmac_secret = this.hmacSecret.toString('base64')
        options.global_ycm_extra_conf = this.settings.ycmd.global_extra_config
        options.confirm_extra_conf = this.settings.ycmd.confirm_extra_conf
        options.extra_conf_globlist = []
        options.rustSrcPath = ''
        const optionsFile = path.resolve(os.tmpdir(), `VSCodeYcmOptions-${Date.now()}`)
        logger(`processData: ${JSON.stringify(options)}`)
        return new Promise<string>((resolve, reject) => {
            fs.writeFile(optionsFile, JSON.stringify(options), {encoding: 'utf8'}, (err) => {
                if (err) reject(err)
                else resolve(optionsFile)
            })
        })
    }

    private _start(optionsFile): Promise<childProcess.ChildProcess> {
        return new Promise<childProcess.ChildProcess>((resolve, reject) => {
            let cmd = this.settings.ycmd.python
            let args = [
                path.resolve(this.settings.ycmd.path, 'ycmd'),
                `--port=${this.port}`,
                `--options_file=${optionsFile}`,
                `--idle_suicide_seconds=600`
            ]
            if (process.platform === 'win32') {
                args = args.map(it => `"${it.replace(/"/g, '\\"')}"`)
                cmd = `"${cmd.replace(/"/g, '\\"')}"`
                args.unshift(cmd)
                args = ['/s', '/d', '/c', `"${args.join(' ')}"`]
                cmd = 'cmd.exe'
            }

            const options = {
                windowsVerbatimArguments: true,
                cwd: this.workingDir,
                env: process.env
            }
            logger('_start', args)
            const cp = childProcess.spawn(cmd, args, options)
            logger('_start', `process spawn success ${cp.pid}`)
            cp.stdout.on('data', (data: Buffer) => logger(`ycm stdout`, crossPlatformBufferToString(data)))
            cp.stderr.on('data', (data: Buffer) => logger(`ycm stderr`, crossPlatformBufferToString(data)))
            cp.on('error', (err) => {
                logger('_start error', err)
            })
            cp.on('exit', (code) => {
                logger('_start exit', code)
                this.process = null
                switch (code) {
                    case 3: reject(new Error('Unexpected error while loading the YCM core library.'))
                    case 4: reject(new Error('YCM core library not detected; you need to compile YCM before using it. Follow the instructions in the documentation.'))
                    case 5: reject(new Error('YCM core library compiled for Python 3 but loaded in Python 2. Set the Python Executable config to a Python 3 interpreter path.'))
                    case 6: reject(new Error('YCM core library compiled for Python 2 but loaded in Python 3. Set the Python Executable config to a Python 2 interpreter path.'))
                    case 7: reject(new Error('YCM core library too old; PLEASE RECOMPILE by running the install.py script. See the documentation for more details.'))
                }
            })
            setTimeout(() => resolve(cp), 1000)
        })
    }

    private static async start(workingDir: string, settings: Settings, window: RemoteWindow): Promise<Ycm> {
        try {
            const ycm = new Ycm(settings)
            ycm.workingDir = workingDir
            ycm.window = window
            const data = await Promise.all<any>([ycm.findUnusedPort(), ycm.generateRandomSecret(), ycm.readDefaultOptions()]) as [number, Buffer, any]
            logger('start', `data: ${data}`)
            const optionsFile = await ycm.processData(data)
            logger('start', `optionsFile: ${optionsFile}`)
            ycm.process = await ycm._start(optionsFile)
            logger('start', `ycm started: ${ycm.process.pid}`)
            return ycm
        } catch (err) {
            logger('start error', err)
            return null
        }
    }

    private static Instance: Ycm
    private static Initializing = false
    public static async getInstance(workingDir: string, settings: Settings, window: RemoteWindow): Promise<Ycm> {
        if (Ycm.Initializing) return new Promise<Ycm>((resolve, reject) => {
            setTimeout(() => resolve(Ycm.getInstance(workingDir, settings, window)), 50)
        })
        if (!Ycm.Instance || Ycm.Instance.workingDir !== workingDir || !_.isEqual(Ycm.Instance.settings, settings) || !Ycm.Instance.process) {
            logger('getInstance', `ycm is restarting`)
            if (!!Ycm.Instance) Ycm.Instance.reset()
            try {
                Ycm.Initializing = true
                Ycm.Instance = await Ycm.start(workingDir, settings, window)
            } catch (err) {
                logger('getInstance error', err)
            }
            Ycm.Initializing = false
        }
        return Ycm.Instance
    }

    public async reset() {
        if (!!this.process) {
            if (process.platform === 'win32') await this.killOnWindows()
            // TODO: kill cmd.exe may not kill python
            this.process.kill()
            this.port = null
            this.hmacSecret = null
        }
    }

    private killOnWindows() {
        return new Promise((resolve, reject) => {
            const parentPid = this.process.pid
            const wmic = childProcess.spawn('wmic', [
                'process', 'where', `(ParentProcessId=${parentPid})`, 'get', 'processid'
            ])
            wmic.on('error', (err) => logger('killOnWindows error', err))
            let output = ''
            wmic.stdout.on('data', (data: string) => output += data)
            wmic.stdout.on('close', () => {
                output.split(/\s+/)
                    .filter(pid => /^\d+$/.test(pid))
                    .map(pid => parseInt(pid))
                    .filter(pid => pid !== parentPid && pid > 0 && pid < Infinity)
                    .map(pid => process.kill(pid))
                resolve()
            })
        })
    }

    private buildRequest(currentDocument: string, position: Position = null, documents: TextDocuments = null, event: string = null) {
        return new YcmRequest(this.window, this.port, this.hmacSecret, this.workingDir, currentDocument, position, documents, event)
    }

    private runCompleterCommand(documentUri: string, position: Position, documents: TextDocuments, command: string) {
        return this.buildRequest(documentUri, position, documents, command).isCommand().request()
    }

    private eventNotification(documentUri: string, position: Position, documents: TextDocuments, event: string) {
        return this.buildRequest(documentUri, position, documents, event).request()
    }

    public async getReady(documentUri: string, documents: TextDocuments) {
        const response = await this.eventNotification(documentUri, null, documents, 'BufferVisit')
        logger(`getReady`, JSON.stringify(response))
    }

    public async completion(documentUri: string, position: Position, documents: TextDocuments): Promise<CompletionItem[]> {
        const request = this.buildRequest(documentUri, position, documents)
        const response = await request.request('completions')
        const completions = response['completions'] as YcmCompletionItem[]
        const res = mapYcmCompletionsToLanguageServerCompletions(completions)
        logger(`completion`, `ycm responsed ${res.length} items`)
        return res
    }

    public async getType(documentUri: string, position: Position, documents: TextDocuments) {
        const type = await this.runCompleterCommand(documentUri, position, documents, 'GetType') as YcmGetTypeResponse
        logger('getType', JSON.stringify(type))
        return mapYcmTypeToHover(type, documents.get(documentUri).languageId)
    }

    public async goToDefinition(documentUri: string, position: Position, documents: TextDocuments) {
        const definition = await this.runCompleterCommand(documentUri, position, documents, 'GoToDefinition')
        logger('goToDefinition', JSON.stringify(definition))
        return mapYcmLocationToLocation(definition as YcmLocation)
    }

    public async getDoc(documentUri: string, position: Position, documents: TextDocuments) {
        const doc = await this.runCompleterCommand(documentUri, position, documents, 'GetDoc')
        logger('getDoc', JSON.stringify(doc))
    }

    public async getDocQuick(documentUri: string, position: Position, documents: TextDocuments) {
        const doc = await this.runCompleterCommand(documentUri, position, documents, 'GetDocQuick')
        logger('getDocQuick', JSON.stringify(doc))
    }

    public async readyToParse(documentUri: string, documents: TextDocuments): Promise<Diagnostic[]> {
        try {
            const response = await this.eventNotification(documentUri, null, documents, 'FileReadyToParse')
            if (!_.isArray(response)) return []
            logger(`readyToParse`, `ycm responsed ${response.length} items`)
            const issues = response as YcmDiagnosticItem[]
            const uri = crossPlatformUri(documentUri)
            return mapYcmDiagnosticToLanguageServerDiagnostic(issues.filter(it => it.location.filepath === uri))
                .filter(it => !!it.range)
        } catch (err) {
            return []
        }
    }

    public async currentIdentifierFinished(documentUri: string, documents: TextDocuments) {
        await this.eventNotification(documentUri, null, documents, 'CurrentIdentifierFinished')
    }

    public async insertLeave(documentUri: string, documents: TextDocuments) {
        await this.eventNotification(documentUri, null, documents, 'InsertLeave')
    }
}

export type YcmCompletionItem = {
    menu_text: string
    insertion_text: string
    detailed_info: string
    extra_menu_info: string
    kind: string
}

export type YcmLocation = {
    filepath: string,
    column_num: number,
    line_num: number
}

export type YcmRange = {
    start: YcmLocation
    end: YcmLocation
}

export type YcmDiagnosticItem = {
    kind: 'ERROR' | 'WARNING'
    text: string
    ranges: YcmRange[]
    location: YcmLocation
    location_extent: YcmRange
    fixit_available: boolean
}

export type YcmGetTypeResponse = {
    message: string
}

export interface Settings {
    ycmd: {
        path: string
        global_extra_config: string,
        python: string,
        confirm_extra_conf: boolean,
        debug: boolean
    }
}