import axios from 'axios'
import chalk from 'chalk'
import ora from 'ora'
import { Transform, type TransformCallback } from 'stream'
import { type Message, ROLES } from './role'

type Callback = (content: string) => void

interface ChatOption {
  /** OpenApi 的 Key */
  apiKey: string
  /** 扮演的角色 */
  role?: string
  /** 温度。0-2 之间，可以理解为思维发散程度，值越高结果会更加随机，反之更加集中和确定 */
  temperature?: number
};

const spinner = ora({
  prefixText: chalk.gray('\n请求数据中，请稍后'),
  spinner: 'soccerHeader'
})

class DataTransform extends Transform {
  private readonly done: Callback
  private content: string

  constructor (cb: Callback) {
    super()
    this.done = cb
    this.content = ''
  }

  _transform (
    chunk: any,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const chunkStr = chunk.toString().trim()
    const dataArr = chunkStr.split('\n\n')

    // 一个 chunk 里可能有多个 data 事件内容，所以在这里需要进行特殊处理
    dataArr.forEach((item: string) => {
      const data = item.replace('data: ', '')
      if (data === '[DONE]') {
        return
      }
      // 转成对象，拿到具体的内容
      const dataObj = safeParse(data)
      const msg: string = dataObj?.choices?.[0]?.delta?.content
      if (msg) {
        // 如果消息开头有空白符，则去掉
        const formatMsg = !this.content ? msg.trimStart() : msg
        this.content += formatMsg
        this.push(chalk.yellow(formatMsg))
      }
    })
    callback()
  }

  _flush (callback: TransformCallback): void {
    this.done(this.content)
    this.push('\n\n')
    callback()
  }
}

class LimitQueue {
  private readonly capacity: number
  private readonly queue: Message[]

  constructor (capacity: number) {
    this.capacity = capacity
    this.queue = []
  }

  enqueue (item: Message): void {
    if (this.queue.length === this.capacity) {
      // 如果队列已满，删除队首元素
      this.queue.shift()
    }
    // 将元素添加到队尾
    this.queue.push(item)
  }

  getQueue (): Message[] {
    // 返回当前队列
    return this.queue
  }
}

class ChatGptClient {
  private readonly key: string
  private readonly messageQueue: LimitQueue
  private readonly systemPrompt?: string
  private readonly temperature: number

  constructor (option: ChatOption) {
    const { apiKey, temperature, role } = option
    this.temperature = temperature ?? 0.7
    this.key = apiKey.trim()
    // 仅保留 5 条上下文信息，防止堆栈溢出
    this.messageQueue = new LimitQueue(5)
    this.systemPrompt = ROLES.find(item => item.act === role)?.prompt
    if (this.systemPrompt) {
      console.log(`\n${chalk.bold.yellow('系统消息: ')}${chalk.gray(this.systemPrompt)}\n`)
    }
  }

  public async createChatCompletion (content: string): Promise<void> {
    // 将用户发送信息放进消息队列
    this.messageQueue.enqueue({ role: 'user', content })
    spinner.start()
    // 如果有系统消息则带上
    const messages: Message[] = this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }, ...this.messageQueue.getQueue()] : this.messageQueue.getQueue()
    const result = await axios
      .post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages,
          temperature: this.temperature,
          stream: true
        },
        {
          headers: {
            Authorization: `Bearer ${this.key}`
          },
          responseType: 'stream'
        }
      )
      .then((res) => res.data)
      .finally(() => {
        spinner.stop()
      })

    console.log(`\n${chalk.bold.blue('Question: ')}${chalk.gray(content)}`)
    console.log(chalk.bold.green('ChatGPT: '))

    await new Promise((resolve) => {
      const dataTransform = new DataTransform((message: string) => {
        // 将助手返回信息放进消息队列
        this.messageQueue.enqueue({
          role: 'assistant',
          content: message
        })
        resolve(null)
      })
      result.pipe(dataTransform).pipe(process.stdout)
    })
  }

  // 通过发送一个消息来测试 open key 是否有效
  public async checkAuth (): Promise<boolean> {
    try {
      await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'user',
              content: 'hi'
            }
          ],
          stream: true
        },
        {
          headers: {
            Authorization: `Bearer ${this.key}`
          },
          responseType: 'stream'
        }
      )
      return true
    } catch (error) {
      return false
    }
  }
}

function safeParse (str: string): Record<string, any> {
  let obj: Record<string, any> = {}
  try {
    obj = JSON.parse(str)
  } catch (error) {}
  return obj
}

export { ChatGptClient }
