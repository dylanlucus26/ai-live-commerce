#include <mach/mach.h>
#include <mach/task_policy.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void check(kern_return_t value,const char *action){
  if(value!=KERN_SUCCESS){fprintf(stderr,"%s: %s (%d)\n",action,mach_error_string(value),value);exit(1);}
}
int main(int argc,char **argv){
  if(!getenv("GITHUB_ACTIONS")||strcmp(getenv("GITHUB_ACTIONS"),"true")||argc!=2||
     (strcmp(argv[1],"original")&&strcmp(argv[1],"latency0"))){
    fprintf(stderr,"Expected an isolated cloud original/latency0 self-launch probe\n");return 1;
  }
  // Only this newly created process is eligible. No target PID, task-for-pid,
  // third-party entitlement, signature modification or privilege escalation.
  task_t task=mach_task_self();
  struct task_qos_policy base={0},before={0},after={0};
  mach_msg_type_number_t count=TASK_QOS_POLICY_COUNT;boolean_t def=FALSE;
  check(task_policy_get(task,TASK_BASE_QOS_POLICY,(task_policy_t)&base,&count,&def),"read own base QoS");
  count=TASK_QOS_POLICY_COUNT;def=FALSE;
  check(task_policy_get(task,TASK_OVERRIDE_QOS_POLICY,(task_policy_t)&before,&count,&def),"read own override QoS");
  after=before;
  if(!strcmp(argv[1],"latency0")){
    after.task_latency_qos_tier=LATENCY_QOS_TIER_0;
    check(task_policy_set(task,TASK_OVERRIDE_QOS_POLICY,(task_policy_t)&after,TASK_QOS_POLICY_COUNT),"set own launch latency");
    struct task_qos_policy actual={0};count=TASK_QOS_POLICY_COUNT;def=FALSE;
    check(task_policy_get(task,TASK_OVERRIDE_QOS_POLICY,(task_policy_t)&actual,&count,&def),"read own actual launch latency");
    if(memcmp(&actual,&after,sizeof(actual))){fprintf(stderr,"Own pre-exec policy readback mismatch\n");return 1;}
  }
  printf("POLICY BEFORE EXEC: {\"pid\":%d,\"mode\":\"%s\",\"baseLatency\":%d,\"baseThroughput\":%d,"
    "\"beforeLatency\":%d,\"beforeThroughput\":%d,\"afterLatency\":%d,\"afterThroughput\":%d}\n",
    getpid(),argv[1],base.task_latency_qos_tier,base.task_throughput_qos_tier,
    before.task_latency_qos_tier,before.task_throughput_qos_tier,
    after.task_latency_qos_tier,after.task_throughput_qos_tier);
  fflush(stdout);
  char *const args[]={"/Applications/OBS.app/Contents/MacOS/OBS","--multi","--disable-updater",
    "--disable-missing-files-check","--profile","AI-Live-CI","--collection","AI-Live-CI",
    "--websocket_port","4455","--websocket_password","obs-local-ci-only","--websocket_ipv4_only",NULL};
  execv(args[0],args);perror("exec official OBS");return 1;
}
