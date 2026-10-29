#include <mach/mach.h>
#include <mach/task_policy.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

static void check(kern_return_t value,const char *action){
  if(value!=KERN_SUCCESS){fprintf(stderr,"%s: %s (%d)\n",action,mach_error_string(value),value);exit(1);}
}
static int integer(const char *s){
  char *end=NULL;errno=0;long v=strtol(s,&end,10);
  if(errno||!end||*end||v<0||v>0x7fffffff){fprintf(stderr,"Invalid policy integer\n");exit(1);}
  return (int)v;
}
int main(int argc,char **argv){
  if(!getenv("GITHUB_ACTIONS")||strcmp(getenv("GITHUB_ACTIONS"),"true")||
     !getenv("AI_LIVE_OBS_TEST_PID")||argc<2||strcmp(argv[1],getenv("AI_LIVE_OBS_TEST_PID"))){
    fprintf(stderr,"Only the explicitly owned isolated-cloud OBS PID is eligible\n");return 1;
  }
  pid_t pid=integer(argv[1]);char path[PROC_PIDPATHINFO_MAXSIZE]={0};
  if(pid<=0||proc_pidpath(pid,path,sizeof(path))<=0||
     strcmp(path,"/Applications/OBS.app/Contents/MacOS/OBS")){
    fprintf(stderr,"Owned official OBS executable path did not match\n");return 1;
  }
  mach_port_t task=MACH_PORT_NULL;
  check(task_name_for_pid(mach_task_self(),pid,&task),"task_name_for_pid");
  struct task_qos_policy base={0},override={0};
  task_category_policy_data_t category={0};
  mach_msg_type_number_t count=TASK_QOS_POLICY_COUNT;boolean_t def=FALSE;
  check(task_policy_get(task,TASK_BASE_QOS_POLICY,(task_policy_t)&base,&count,&def),"read base QoS");
  count=TASK_QOS_POLICY_COUNT;def=FALSE;
  check(task_policy_get(task,TASK_OVERRIDE_QOS_POLICY,(task_policy_t)&override,&count,&def),"read override QoS");
  count=TASK_CATEGORY_POLICY_COUNT;def=FALSE;
  check(task_policy_get(task,TASK_CATEGORY_POLICY,(task_policy_t)&category,&count,&def),"read task role");
  if(argc==4){
    struct task_qos_policy requested={integer(argv[2]),integer(argv[3])};
    check(task_policy_set(task,TASK_OVERRIDE_QOS_POLICY,(task_policy_t)&requested,TASK_QOS_POLICY_COUNT),
      "set owned OBS override QoS");
    count=TASK_QOS_POLICY_COUNT;def=FALSE;
    check(task_policy_get(task,TASK_OVERRIDE_QOS_POLICY,(task_policy_t)&override,&count,&def),
      "read actual overridden QoS");
    if(memcmp(&override,&requested,sizeof(override))){fprintf(stderr,"Actual QoS readback mismatch\n");return 1;}
  }else if(argc!=2){fprintf(stderr,"Expected PID or PID LATENCY THROUGHPUT\n");return 1;}
  printf("{\"pid\":%d,\"role\":%d,\"base\":{\"latency\":%d,\"throughput\":%d},"
    "\"override\":{\"latency\":%d,\"throughput\":%d}}\n",
    pid,category.role,base.task_latency_qos_tier,base.task_throughput_qos_tier,
    override.task_latency_qos_tier,override.task_throughput_qos_tier);
  mach_port_deallocate(mach_task_self(),task);return 0;
}
