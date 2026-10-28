import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { endianness } from 'node:os'

/** Only an accepted receiver-side loopback socket counts; client sockets do not.
 * An established TCP socket proves transport presence, never decoded media.
 */
export async function hasEstablishedLoopbackReceiver(host:string,port:number):Promise<boolean|undefined> {
  if(!['127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<1||port>65535)return undefined
  const endpoints=new Set(host==='::1'?['[::1]:'+port,'::1:'+port]:
    ['127.0.0.1:'+port,'[::ffff:127.0.0.1]:'+port])
  if(process.platform==='darwin'){
    return new Promise(resolve=>{
      execFile('/usr/sbin/lsof',['-nP','-a','-iTCP:'+port,'-sTCP:ESTABLISHED','-Fn'],
        {encoding:'utf8',timeout:2000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
          if(error){
            const code=(error as {code?:number|string}).code
            resolve(code===1&&!stderr.trim()?false:undefined)
            return
          }
          resolve(stdout.split('\n').some(line=>line.startsWith('n')&&endpoints.has(line.slice(1).split('->')[0])))
        })
    })
  }
  if(process.platform==='win32'){
    return new Promise(resolve=>{
      execFile('netstat.exe',['-ano','-p',host==='::1'?'tcpv6':'tcp'],
        {encoding:'utf8',timeout:2000,maxBuffer:2*1024*1024,windowsHide:true},(error,stdout)=>{
          if(error){resolve(undefined);return}
          let unknown=false
          for(const line of stdout.split('\n')){
            const cells=line.trim().split(/\s+/u)
            if(cells[0]?.toUpperCase()!=='TCP'||!endpoints.has(cells[1]))continue
            if(cells[3]==='ESTABLISHED'){resolve(true);return}
            if(!['LISTENING','CLOSED','CLOSE_WAIT','TIME_WAIT','FIN_WAIT_1','FIN_WAIT_2',
              'LAST_ACK','CLOSING','SYN_SENT','SYN_RECEIVED','BOUND'].includes(cells[3]))unknown=true
          }
          resolve(unknown?undefined:false)
        })
    })
  }
  if(process.platform==='linux'){
    try{
      const tables=await Promise.all(['/proc/net/tcp','/proc/net/tcp6'].map(path=>
        readFile(path,'utf8').catch(error=>{
          if((error as NodeJS.ErrnoException).code==='ENOENT')return ''
          throw error
        })))
      const expected=host==='::1'?['00000000000000000000000000000001']:
        ['7f000001','00000000000000000000ffff7f000001']
      const normalize=(hex:string)=>endianness()==='LE'
        ?(hex.match(/.{8}/gu)??[]).map(word=>(word.match(/../gu)??[]).reverse().join('')).join('').toLowerCase()
        :hex.toLowerCase()
      return tables.some(table=>table.split('\n').some(line=>{
        const fields=line.trim().split(/\s+/u)
        if(fields[3]!=='01')return false
        const [address,encodedPort]=fields[1]?.split(':')??[]
        return !!address&&parseInt(encodedPort,16)===port&&expected.includes(normalize(address))
      }))
    }catch{return undefined}
  }
  return undefined
}
